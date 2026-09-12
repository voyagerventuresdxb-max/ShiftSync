import { Router } from 'express';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import { prisma } from '../lib/prisma.js';
import { parseWorkbookBuffer, buildMergeExpandedGrid, listOtherSheetNames, TemplateDetectionError } from '../parsing/parseWorkbook.js';
import { parseExcelGrid, RosterExtractionAnomalyError } from '../parsing/deterministicGridParser.js';
import { extractPdfGrid, hasPdfTextLayer } from '../parsing/pdfTableExtractor.js';
import { parseRosterText, currentWeekStart } from '../parsing/parseText.js';
import { parseRosterGrid, parseRosterImage, VisionIngestionError } from '../parsing/parseVision.js';
import { parseScannedPdfViaDocling, DoclingUnavailableError } from '../parsing/doclingClient.js';
import { resolveRowsAgainstDatabase } from '../parsing/resolveRows.js';
import { persistShifts } from '../parsing/persistShifts.js';
import type { AnomalyRecord, LeaveRecord, ParsedShiftRow, ParsedVisionResult, RowIssue } from '../parsing/types.js';
import { uploadCache } from '../store/uploadCache.js';
import { requireSession, requireManager, ownedOrNotFound } from '../middleware/requireSession.js';
import { rosterUploadRateLimiter } from '../middleware/rateLimit.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { notifySchedulePublished, mondayOfWeek } from '../lib/scheduleNotifications.js';

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Guards on the paid vision-fallback path only (hosted Gemini/Vertex AI
// call for image/scanned-PDF uploads) — the deterministic Excel/CSV/
// text-layer-PDF path is unaffected by either limit.
const VISION_FALLBACK_MAX_BYTES = 5 * 1024 * 1024;
const VISION_FALLBACK_RATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns a user-facing rejection message when the vision-fallback path
 * shouldn't run for this upload (file too large, or this venue already
 * used its one-per-week allowance) — null when it's allowed to proceed.
 */
async function checkVisionFallbackAllowed(fileSize: number, locationId: string): Promise<string | null> {
  if (fileSize > VISION_FALLBACK_MAX_BYTES) {
    return `This file is ${(fileSize / (1024 * 1024)).toFixed(1)}MB, over the ${VISION_FALLBACK_MAX_BYTES / (1024 * 1024)}MB limit for AI-assisted roster reading. Please upload a smaller image/PDF, or use an Excel/CSV export instead.`;
  }
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { lastVisionFallbackUsedAt: true } });
  const lastUsed = location?.lastVisionFallbackUsedAt;
  if (lastUsed && Date.now() - lastUsed.getTime() < VISION_FALLBACK_RATE_LIMIT_MS) {
    const nextAvailable = new Date(lastUsed.getTime() + VISION_FALLBACK_RATE_LIMIT_MS);
    return (
      `AI-assisted roster reading for this venue was already used this week ` +
      `(last used ${lastUsed.toISOString().slice(0, 10)}) — it's limited to once per venue per week. ` +
      `It'll be available again on ${nextAvailable.toISOString().slice(0, 10)}. Try an Excel/CSV export in the meantime.`
    );
  }
  return null;
}

/** Records that this venue's one-per-week vision-fallback allowance was just used. Call only after a successful parse. */
async function markVisionFallbackUsed(locationId: string): Promise<void> {
  await prisma.location.update({ where: { id: locationId }, data: { lastVisionFallbackUsedAt: new Date() } });
}

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
schedulesRouter.post('/upload', requireSession, rosterUploadRateLimiter, upload.single('file'), async (req, res) => {
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
      // templates) — pass the raw image straight to the hosted Gemini
      // vision model in a single call. No local OCR/geometry pre-pass — the
      // model reads the matrix (staff column x day header row) directly off
      // the pixels. See parseVision.ts for EU-region Vertex AI config.
      const blockReason = await checkVisionFallbackAllowed(req.file.size, locationId);
      if (blockReason) return res.status(422).json({ error: blockReason, errorCode: 'vision_fallback_blocked' });
      try {
        const visionResult = await parseRosterImage(req.file.buffer, req.file.mimetype, req.file.originalname, weekStart);
        parsed = { rows: visionResult.rows, issues: visionResult.issues, templateLabel: visionResult.templateLabel };
        anomalies = visionResult.anomalies;
        leaveRecords = visionResult.leaveRecords;
        legend = visionResult.legend;
        await markVisionFallbackUsed(locationId);
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
        // Docling sidecar before the hosted vision model (Docling is free
        // and local; worth trying first when it might already produce a
        // clean table). Deliberately scoped to ONLY this branch: evaluated
        // against both permanent fixtures, Docling's layout model failed to
        // detect any table region at all on a text-layer/borderless-grid
        // PDF (Gattopardo — strictly worse than the deterministic parser
        // above), but correctly structured a scanned no-text-layer roster
        // (Bar des Pres, 22x9, ~47s). See doclingClient.ts and
        // server/docling-sidecar/ for the evaluation.
        let doclingResult: ParsedVisionResult | null = null;
        try {
          doclingResult = await parseScannedPdfViaDocling(req.file.buffer, req.file.originalname, weekStart);
        } catch (err) {
          if (err instanceof DoclingUnavailableError) {
            // Sidecar not running/unreachable/timed out — not a hard
            // failure, just fall through to the hosted vision model below.
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
          const blockReason = await checkVisionFallbackAllowed(req.file.size, locationId);
          if (blockReason) return res.status(422).json({ error: blockReason, errorCode: 'vision_fallback_blocked' });
          try {
            // Gemini/Vertex accepts PDF bytes directly (unlike the old
            // Ollama path, which needed a rasterized PNG because its image
            // loader can't decode a PDF container) — send the original file
            // straight through, no rasterization step needed.
            const visionResult = await parseRosterImage(req.file.buffer, 'application/pdf', req.file.originalname, weekStart);
            parsed = { rows: visionResult.rows, issues: visionResult.issues, templateLabel: visionResult.templateLabel };
            anomalies = visionResult.anomalies;
            leaveRecords = visionResult.leaveRecords;
            legend = visionResult.legend;
            await markVisionFallbackUsed(locationId);
          } catch (err) {
            if (err instanceof VisionIngestionError) {
              return res.status(422).json({ error: err.message });
            }
            throw err;
          }
        }
      } else {
        // Text layer present but the deterministic grid parser couldn't
        // make sense of it — try the line-oriented text parser (cheap, no
        // API call), then the hosted vision model. Docling is NOT tried
        // here — it has no demonstrated value on text-layer PDFs (see the
        // branch above) and one clear negative data point.
        const text = await extractPdfText(req.file.buffer);
        const textResult = text ? parseRosterText(text, weekStart) : null;
        if (textResult && textResult.rows.length > 0) {
          parsed = { rows: textResult.rows, issues: textResult.issues, templateLabel: 'PDF Text Roster' };
        } else {
          const blockReason = await checkVisionFallbackAllowed(req.file.size, locationId);
          if (blockReason) return res.status(422).json({ error: blockReason, errorCode: 'vision_fallback_blocked' });
          try {
            const visionResult = await parseRosterImage(req.file.buffer, 'application/pdf', req.file.originalname, weekStart);
            parsed = { rows: visionResult.rows, issues: visionResult.issues, templateLabel: visionResult.templateLabel };
            anomalies = visionResult.anomalies;
            leaveRecords = visionResult.leaveRecords;
            legend = visionResult.legend;
            await markVisionFallbackUsed(locationId);
          } catch (err) {
            if (err instanceof VisionIngestionError) {
              return res.status(422).json({ error: err.message });
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
          // Every parser in this app only ever reads the workbook's first
          // sheet (see listOtherSheetNames' own doc comment) — a
          // multi-tab file (per-outlet, per-week archive, a notes tab
          // first) can have its real roster sitting on a tab that's never
          // looked at, with no indication of that in an otherwise
          // confidently-successful result. Surfaced unconditionally
          // whenever more than one sheet exists, regardless of whether
          // the first sheet's own parse succeeds — the manager, not the
          // app, is the one who can tell whether the other tabs matter.
          const otherSheetNames = listOtherSheetNames(req.file.buffer, req.file.originalname);
          const ignoredSheetsAnomaly: AnomalyRecord | null =
            otherSheetNames.length > 0
              ? {
                  employeeName: null,
                  date: null,
                  rawText: otherSheetNames.join(', '),
                  reason:
                    `This file has ${otherSheetNames.length} other sheet(s) that were not read (${otherSheetNames.join(', ')}) — ` +
                    `only the first sheet was parsed, and no rows were extracted from the other sheet(s) listed above ` +
                    `(this is a diagnostic, not an automatic recovery). If your roster data is on a different tab, move ` +
                    `or copy it to the first tab and re-upload.`,
                  confidence: 0,
                  rowNumber: null,
                  kind: 'ignored_workbook_sheets',
                }
              : null;
          const deterministicResult = parseExcelGrid(grid, weekStart);
          const deterministicRecognizedShape = deterministicResult.templateLabel === 'Deterministic Grid Parser';

          if (deterministicRecognizedShape) {
            parsed = { rows: deterministicResult.rows, issues: deterministicResult.issues, templateLabel: deterministicResult.templateLabel };
            anomalies = ignoredSheetsAnomaly ? [ignoredSheetsAnomaly, ...deterministicResult.anomalies] : deterministicResult.anomalies;
            leaveRecords = deterministicResult.leaveRecords;
            legend = deterministicResult.legend;
          } else {
            try {
              const gridResult = await parseRosterGrid(grid, req.file.originalname, weekStart);
              parsed = { rows: gridResult.rows, issues: gridResult.issues, templateLabel: gridResult.templateLabel };
              anomalies = ignoredSheetsAnomaly ? [ignoredSheetsAnomaly, ...gridResult.anomalies] : gridResult.anomalies;
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
    if (err instanceof RosterExtractionAnomalyError) {
      // A day-grid shape WAS recognized but real shift data was dropped
      // during classification (e.g. an ALL-CAPS staff row misread as a
      // section header) — a loud, visible failure for the manager to see
      // and retry/escalate, not a silent 200-success with missing rows.
      return res.status(422).json({ error: err.message, errorCode: 'roster_extraction_anomaly' });
    }
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
 * `requireManager`-gated (2026-09-05 — see MEMORY.md; a real, pre-existing
 * gap the `withAuditedTransaction` review found: this was `requireSession`-
 * only, so any authenticated STAFF session could confirm a batch — including
 * one uploaded by someone else at the same venue, since `ownedOrNotFound`
 * only checks venue, not uploader — bulk-creating real Shift rows for the
 * whole venue). The batch must still belong to the caller's venue.
 */
schedulesRouter.post('/upload/:batchId/confirm', requireSession, requireManager, async (req, res) => {
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

    const result = await withAuditedTransaction(
      prisma,
      (tx) => persistShifts(tx, batch.locationId, createdById, batch.rows),
      // Only write a real audit row when at least one shift was actually
      // created — a batch where every row was skipped for an unresolved
      // role (persisted.createdCount === 0) would otherwise still produce a
      // SHIFT_CREATED entry pointing at the batchId (not a real Shift id),
      // a false compliance-audit record claiming a shift was created when
      // none was. Same guard shape as floorPlan.ts's publish route.
      (persisted) =>
        persisted.createdCount > 0
          ? {
              locationId: batch.locationId,
              actorId: req.user!.id,
              action: 'SHIFT_CREATED',
              entityType: 'Shift',
              entityId: persisted.rows[0]!.shiftId,
              shiftId: persisted.rows[0]!.shiftId,
              note: `Imported ${persisted.createdCount} shift(s) from roster upload (${persisted.skippedCount} skipped)`,
            }
          : null,
    );
    // Deleted only after the transaction commits — deleting it before commit
    // and then having the transaction roll back (e.g. the audit write fails)
    // would permanently strand the batch as unretryable with nothing
    // actually persisted. This does leave a narrow window where a duplicate
    // concurrent confirm on the same batchId isn't caught (see MEMORY.md).
    uploadCache.delete(batchId);

    // Real delivery on top of the write above (never inside the transaction
    // — see shifts.ts's publish route for the same rationale). Uploaded
    // shifts are written straight to PUBLISHED, bypassing the manual
    // /publish endpoint entirely — without this, staff whose schedule
    // arrives via roster upload would never be notified at all. Grouped by
    // week (a single upload can span several) so one person with shifts in
    // two different weeks gets two digests, each naming the right week, not
    // one digest naming an ambiguous or arbitrary date.
    const byWeek = new Map<string, Set<string>>();
    for (const row of result.rows) {
      if (!row.userId) continue;
      const weekStart = mondayOfWeek(row.date);
      const userIds = byWeek.get(weekStart) ?? new Set<string>();
      userIds.add(row.userId);
      byWeek.set(weekStart, userIds);
    }
    for (const [weekStart, userIds] of byWeek) {
      void notifySchedulePublished([...userIds], weekStart);
    }

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
