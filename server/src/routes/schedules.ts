import { Router } from 'express';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import { prisma } from '../lib/prisma.js';
import { parseWorkbookBuffer, buildMergeExpandedGrid, TemplateDetectionError } from '../parsing/parseWorkbook.js';
import { parseExcelGrid } from '../parsing/deterministicGridParser.js';
import { extractPdfGrid, hasPdfTextLayer } from '../parsing/pdfTableExtractor.js';
import { parseRosterText, currentWeekStart } from '../parsing/parseText.js';
import { parseRosterGrid, VisionIngestionError } from '../parsing/parseVision.js';
import { parseRosterImageOllama } from '../parsing/parseVisionOllama.js';
import { parseScannedPdfViaDocling, DoclingUnavailableError } from '../parsing/doclingClient.js';
import { rasterizePdfPageToPng, PdfRasterizeError } from '../parsing/pdfRasterize.js';
import { resolveRowsAgainstDatabase } from '../parsing/resolveRows.js';
import { persistShifts } from '../parsing/persistShifts.js';
import type { AnomalyRecord, LeaveRecord, ParsedShiftRow, ParsedVisionResult, RowIssue } from '../parsing/types.js';
import { uploadCache } from '../store/uploadCache.js';
import { requireSession, ownedOrNotFound } from '../middleware/requireSession.js';
import { writeAuditLog } from '../lib/auditLog.js';

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
      'text/csv',
      'application/csv',
      'application/pdf', // .pdf
      ...IMAGE_MIME_TYPES,
    ];
    const allowedExt = /\.(xlsx|xls|csv|pdf|png|jpe?g|webp|gif)$/i;
    if (allowed.includes(file.mimetype) || allowedExt.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type "${file.mimetype || file.originalname}". Upload a .xlsx, .xls, .csv, .pdf, .png, .jpg, or .webp file.`));
    }
  },
});

/** True when the uploaded file is a PDF (by extension or mimetype). */
function isPdf(file: Express.Multer.File): boolean {
  return (
    file.mimetype === 'application/pdf' ||
    /\.pdf$/i.test(file.originalname)
  );
}

/** True when the uploaded file is a raster image — routed straight to the VLM ingestion path. */
function isImage(file: Express.Multer.File): boolean {
  return IMAGE_MIME_TYPES.includes(file.mimetype) || /\.(png|jpe?g|webp|gif)$/i.test(file.originalname);
}

/**
 * Extract plain text from a PDF buffer. Returns the concatenated document
 * text, or null when the PDF yields no extractable text (e.g. a scanned
 * image-only PDF with no OCR layer).
 */
async function extractPdfText(buffer: Buffer): Promise<string | null> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result?.text ?? '').trim();
    return text.length > 0 ? text : null;
  } finally {
    await parser.destroy();
  }
}

export const schedulesRouter = Router();

/**
 * POST /api/schedules/upload
 * multipart/form-data: file=<xlsx|xls|csv>
 *
 * Parses + validates the sheet against the 3 master templates, resolves
 * rows against existing Role/User records for the location, and returns a
 * sanity-check preview. Nothing is written to the database at this stage.
 * The response includes a `batchId` to pass to the confirm step below.
 * Session-gated: locationId is derived from the caller's session.
 */
schedulesRouter.post('/upload', requireSession, upload.single('file'), async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Attach it under the "file" field.' });
    }

    // Optional reference week for text/PDF rosters that use day names
    // ("Mon", "Friday") instead of explicit dates. Defaults to the current
    // week's Sunday. Ignored for Excel/CSV, which carry their own dates.
    const weekStart = String(req.body?.weekStart ?? '').trim() || currentWeekStart();

    let parsed: { rows: ParsedShiftRow[]; issues: RowIssue[]; templateLabel: string | null };
    let anomalies: AnomalyRecord[] = [];
    let leaveRecords: LeaveRecord[] = [];
    let legend: { code: string; meaning: string }[] = [];

    if (isImage(req.file)) {
      // Arbitrary layouts (screenshots, colour-coded grids, hand-made
      // templates) — pass the raw image straight to the local Ollama
      // vision model in a single call. No local OCR/geometry pre-pass, no
      // external API call — the model reads the matrix (staff column x day
      // header row) directly off the pixels, entirely on this machine.
      try {
        const visionResult = await parseRosterImageOllama(req.file.buffer, req.file.mimetype, req.file.originalname, weekStart);
        parsed = { rows: visionResult.rows, issues: visionResult.issues, templateLabel: visionResult.templateLabel };
        anomalies = visionResult.anomalies;
        leaveRecords = visionResult.leaveRecords;
        legend = visionResult.legend;
      } catch (err) {
        if (err instanceof VisionIngestionError) {
          return res.status(422).json({ error: err.message });
        }
        throw err;
      }
    } else if (isPdf(req.file)) {
      // Check for a real, positioned text layer first (pdfjs-dist) — a
      // scanned/photographed PDF has none at all, and no amount of text
      // reconstruction can recover data that was never encoded as text.
      const hasTextLayer = await hasPdfTextLayer(req.file.buffer);

      let deterministicPdfResult: ParsedVisionResult | null = null;
      if (hasTextLayer) {
        // PRIMARY path for a text-layer PDF: reconstruct the grid from
        // real character positions (no network call, fully reproducible)
        // and reuse the exact same deterministic interpreter as Excel/CSV.
        const grid = await extractPdfGrid(req.file.buffer);
        const gridResult = parseExcelGrid(grid, weekStart);
        if (gridResult.templateLabel === 'Deterministic Grid Parser') {
          deterministicPdfResult = gridResult;
        }
      }

      if (deterministicPdfResult) {
        parsed = { rows: deterministicPdfResult.rows, issues: deterministicPdfResult.issues, templateLabel: deterministicPdfResult.templateLabel };
        anomalies = deterministicPdfResult.anomalies;
        leaveRecords = deterministicPdfResult.leaveRecords;
        legend = deterministicPdfResult.legend;
      } else if (!hasTextLayer) {
        // No text layer at all (scanned/photographed PDF) — try the local
        // Docling sidecar before Ollama. Deliberately scoped to ONLY this
        // branch: evaluated against both permanent fixtures, Docling's
        // layout model failed to detect any table region at all on a
        // text-layer/borderless-grid PDF (Gattopardo — strictly worse than
        // the deterministic parser above), but correctly structured a
        // scanned no-text-layer roster (Bar des Pres, 22x9, ~47s) that
        // otherwise only reaches the much slower Ollama fallback. See
        // doclingClient.ts and server/docling-sidecar/ for the evaluation.
        let doclingResult: ParsedVisionResult | null = null;
        try {
          doclingResult = await parseScannedPdfViaDocling(req.file.buffer, req.file.originalname, weekStart);
        } catch (err) {
          if (err instanceof DoclingUnavailableError) {
            // Sidecar not running/unreachable/timed out — not a hard
            // failure, just fall through to Ollama below like today.
            doclingResult = null;
          } else {
            throw err;
          }
        }

        if (doclingResult) {
          console.log(
            `[schedules] PDF resolved via Docling sidecar: ${doclingResult.rows.length} rows, ${doclingResult.anomalies.length} anomalies, ${doclingResult.leaveRecords.length} leave records.`,
          );
        }

        if (doclingResult) {
          parsed = { rows: doclingResult.rows, issues: doclingResult.issues, templateLabel: doclingResult.templateLabel };
          anomalies = doclingResult.anomalies;
          leaveRecords = doclingResult.leaveRecords;
          legend = doclingResult.legend;
        } else {
          try {
            // Ollama's vision API needs real image pixels — req.file.buffer
            // is still the original PDF at this point, which Ollama's image
            // loader can't decode (confirmed root cause of the "Failed to
            // load image or audio file" error: reproduced directly against
            // Ollama with the raw PDF bytes, resolved by sending a real
            // rasterized PNG instead). See pdfRasterize.ts.
            const rasterized = await rasterizePdfPageToPng(req.file.buffer);
            const visionResult = await parseRosterImageOllama(rasterized, 'image/png', req.file.originalname, weekStart);
            parsed = { rows: visionResult.rows, issues: visionResult.issues, templateLabel: visionResult.templateLabel };
            anomalies = visionResult.anomalies;
            leaveRecords = visionResult.leaveRecords;
            legend = visionResult.legend;
          } catch (err) {
            if (err instanceof VisionIngestionError) {
              return res.status(422).json({ error: err.message });
            }
            if (err instanceof PdfRasterizeError) {
              return res.status(422).json({ error: `Could not render this PDF as an image for AI reading: ${err.message}` });
            }
            throw err;
          }
        }
      } else {
        // Text layer present but the deterministic grid parser couldn't
        // make sense of it — unchanged from before Docling: try the
        // line-oriented text parser (cheap, no API call), then Ollama.
        // Docling is NOT tried here — it has no demonstrated value on
        // text-layer PDFs (see the branch above) and one clear negative
        // data point, so this path goes straight to Ollama as it did
        // before this change.
        const text = await extractPdfText(req.file.buffer);
        const textResult = text ? parseRosterText(text, weekStart) : null;
        if (textResult && textResult.rows.length > 0) {
          parsed = { rows: textResult.rows, issues: textResult.issues, templateLabel: 'PDF Text Roster' };
        } else {
          try {
            // Same rasterization step as the branch above — still a PDF
            // buffer here, not an image, regardless of which path led to
            // the Ollama fallback.
            const rasterized = await rasterizePdfPageToPng(req.file.buffer);
            const visionResult = await parseRosterImageOllama(rasterized, 'image/png', req.file.originalname, weekStart);
            parsed = { rows: visionResult.rows, issues: visionResult.issues, templateLabel: visionResult.templateLabel };
            anomalies = visionResult.anomalies;
            leaveRecords = visionResult.leaveRecords;
            legend = visionResult.legend;
          } catch (err) {
            if (err instanceof VisionIngestionError) {
              return res.status(422).json({ error: err.message });
            }
            if (err instanceof PdfRasterizeError) {
              return res.status(422).json({ error: `Could not render this PDF as an image for AI reading: ${err.message}` });
            }
            throw err;
          }
        }
      }
    } else {
      try {
        const workbook = parseWorkbookBuffer(req.file.buffer, req.file.originalname);
        parsed = { rows: workbook.rows, issues: workbook.issues, templateLabel: workbook.templateLabel };
      } catch (err) {
        if (err instanceof TemplateDetectionError) {
          // Doesn't match any of the 3 long-format ("one row per shift")
          // templates — likely a grid-format roster (day-of-week columns,
          // merged section headers). Try the deterministic grid parser
          // first (no network call, fully reproducible) — it's the
          // PRIMARY path for this shape now. Only fall back to the
          // Gemini grid-text engine as a last resort, for layouts the
          // deterministic parser genuinely doesn't recognize (e.g.
          // days-as-rows, or headers it can't locate at all) — this keeps
          // the format coverage already validated for those shapes
          // instead of hard-rejecting the upload.
          const grid = buildMergeExpandedGrid(req.file.buffer, req.file.originalname);
          const deterministicResult = parseExcelGrid(grid, weekStart);
          const deterministicRecognizedShape = deterministicResult.templateLabel === 'Deterministic Grid Parser';

          if (deterministicRecognizedShape) {
            parsed = { rows: deterministicResult.rows, issues: deterministicResult.issues, templateLabel: deterministicResult.templateLabel };
            anomalies = deterministicResult.anomalies;
            leaveRecords = deterministicResult.leaveRecords;
            legend = deterministicResult.legend;
          } else {
            try {
              const gridResult = await parseRosterGrid(grid, req.file.originalname, weekStart);
              parsed = { rows: gridResult.rows, issues: gridResult.issues, templateLabel: gridResult.templateLabel };
              anomalies = gridResult.anomalies;
              leaveRecords = gridResult.leaveRecords;
              legend = gridResult.legend;
            } catch (gridErr) {
              if (gridErr instanceof VisionIngestionError) {
                return res.status(422).json({ error: gridErr.message });
              }
              if (gridErr instanceof TemplateDetectionError) {
                return res.status(422).json({ error: gridErr.message });
              }
              throw gridErr;
            }
          }
        } else {
          throw err;
        }
      }
    }

    // For image/VLM uploads, an all-leave week (or a sheet where every cell
    // needed manager review) is a valid, non-error outcome — anomalies and
    // leaveRecords still carry useful data even with zero workable rows.
    // Only hard-reject when the model produced nothing at all (no rows, no
    // anomalies, no leave records, and no parse issues to surface).
    if (
      parsed.rows.length === 0 &&
      anomalies.length === 0 &&
      leaveRecords.length === 0 &&
      parsed.issues.length === 0
    ) {
      return res.status(422).json({
        error: 'No valid shift rows could be parsed from this file.',
        templateDetected: parsed.templateLabel,
        issues: parsed.issues,
      });
    }

    const { previewRows, summary } = await resolveRowsAgainstDatabase(prisma, locationId, parsed.rows);
    const batchId = uploadCache.put(locationId, null, previewRows);

    return res.status(200).json({
      batchId,
      templateDetected: parsed.templateLabel,
      parseIssues: parsed.issues, // rows dropped before DB resolution (bad dates/times/blank fields)
      summary,
      // VLM-path metadata anomaly fallback: unresolvable cells/codes and
      // non-working-day records, for the manager-review panel. Empty arrays
      // for the Excel/CSV/PDF-text paths, which don't populate them.
      anomalies,
      leaveRecords,
      legend,
      preview: previewRows.map((r) => ({
        rowNumber: r.rowNumber,
        employeeName: r.employeeName,
        role: r.roleName,
        date: r.date,
        startTime: r.startTime,
        endTime: r.endTime,
        overnight: r.overnight,
        breakMinutes: r.breakMinutes,
        managerNotes: r.managerNotes,
        status: r.status,
        issues: r.issues,
      })),
    });
  } catch (err) {
    console.error('[schedules.upload] failed', err);
    if (err instanceof Error) {
      console.error('[schedules.upload] stack:', err.stack);
    }
    return res.status(500).json({ error: 'Unexpected error while processing the upload.' });
  }
});

/**
 * POST /api/schedules/upload/:batchId/confirm
 * body: { createdById?: string }
 *
 * Commits a previously-previewed batch to the Shift table. Rows with an
 * unresolved role are skipped (cannot satisfy the required FK) and reported
 * back in `skippedCount` for the manager to fix and re-upload separately.
 * Session-gated; the batch must belong to the caller's venue.
 */
schedulesRouter.post('/upload/:batchId/confirm', requireSession, async (req, res) => {
  try {
    const { batchId } = req.params;
    const batch = uploadCache.get(batchId);
    if (!ownedOrNotFound(req, res, batch, 'This preview has expired or was already confirmed. Please re-upload the file.')) return;

    const createdById =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.createdById ? String(req.body.createdById).trim() : '') || req.user!.id;

    if (createdById !== req.user!.id) {
      const onBehalfUser = await prisma.user.findUnique({ where: { id: createdById } });
      if (!ownedOrNotFound(req, res, onBehalfUser, `Staff member "${createdById}" not found.`)) return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const persisted = await persistShifts(tx, batch.locationId, createdById, batch.rows);
      await writeAuditLog(tx, {
        locationId: batch.locationId,
        actorId: req.user!.id,
        action: 'SHIFT_CREATED',
        entityType: 'Shift',
        entityId: persisted.rows[0]?.shiftId ?? batchId,
        shiftId: persisted.rows[0]?.shiftId ?? null,
        note: `Imported ${persisted.createdCount} shift(s) from roster upload (${persisted.skippedCount} skipped)`,
      });
      return persisted;
    });
    uploadCache.delete(batchId);

    return res.status(201).json({
      message: `Imported ${result.createdCount} shift(s).`,
      createdCount: result.createdCount,
      skippedCount: result.skippedCount,
      rows: result.rows,
    });
  } catch (err) {
    console.error('[schedules.confirm] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving shifts.' });
  }
});
