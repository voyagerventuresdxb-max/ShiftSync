import { Router } from 'express';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import { prisma } from '../lib/prisma.js';
import { parseWorkbookBuffer, buildMergeExpandedGrid, listOtherSheetNames, TemplateDetectionError } from '../parsing/parseWorkbook.js';
import { parseExcelGrid, RosterExtractionAnomalyError } from '../parsing/deterministicGridParser.js';
import { extractPdfGrid, hasPdfTextLayer, MalformedPdfError } from '../parsing/pdfTableExtractor.js';
import { parseRosterText, currentWeekStart } from '../parsing/parseText.js';
import { isMondayIso, WEEK_START_NOT_MONDAY_ERROR } from '../lib/venueWeek.js';
import { venueTimezoneFor } from '../lib/venueTime.js';
import { AI_TEMPLATE_LABEL, parseRosterGrid, parseRosterImage, VisionIngestionError } from '../parsing/parseVision.js';
import { getVisionProvider } from '../parsing/visionProvider.js';
import { deterministicEscalationReason, ESCALATION_REASON_TEXT, type EscalationReason } from '../parsing/escalation.js';
import { parseScannedPdfViaDocling, DoclingUnavailableError } from '../parsing/doclingClient.js';
import { resolveRowsAgainstDatabase, nameKey, canonicalRoleName } from '../parsing/resolveRows.js';
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
 * The deterministic grid parser the upload route uses. A test seam only: its data-loss gate
 * (RosterExtractionAnomalyError) is defensive and no natural grid trips it any more, so the
 * escalation tests substitute a parser that throws. Never set from production code.
 */
let gridParser: typeof parseExcelGrid = parseExcelGrid;
export function __setGridParserForTests(fn: typeof parseExcelGrid | null): void {
  gridParser = fn ?? parseExcelGrid;
}

/** The manual path, named wherever AI reading can't help. */
const MANUAL_PATH = 'You can also add staff by hand: People → Add staff member.';
const AI_CONSENT_MESSAGE =
  'To read it, ShiftSync needs to send the file to its AI reader, a third-party service outside the UAE. Nothing is sent unless you agree.';

/** What happened to an escalation; returned on the preview so the review screen can say so. */
interface EscalationOutcome {
  reason: EscalationReason;
  status: 'used' | 'needs_consent' | 'unavailable';
  message: string;
}

function withManualPath(message: string): string {
  return /by hand/i.test(message) ? message : `${message} ${MANUAL_PATH}`;
}

/**
 * POST /api/schedules/upload
 * multipart/form-data: file=<xlsx|xls|csv|pdf|image>, weekStart?=YYYY-MM-DD (a Monday),
 * aiConsent?="true" (the manager agreed to send THIS file to the AI reader).
 *
 * The deterministic parsers always run first. The file goes to the vision provider only for
 * one of the reasons in parsing/escalation.ts, only when a provider is configured, and only
 * with `aiConsent` — without it the answer is a 422 `ai_consent_required` (nothing sent) or,
 * when a local result exists, that result plus `escalation.status: 'needs_consent'`. The 5 MB
 * cap and the once-per-venue-per-week allowance apply to every AI read. Nothing is written to
 * the database here: the response is a preview with a `batchId` for the confirm step below.
 * Manager/owner sessions only (like confirm): an AI read costs the venue money and allowance.
 */
schedulesRouter.post('/upload', requireSession, requireManager, rosterUploadRateLimiter, upload.single('file'), async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Attach it under the "file" field.' });
    }
    const file = req.file;

    // Optional reference week for text/PDF rosters that use day names
    // ("Mon", "Friday") instead of explicit dates, and for grid rosters whose
    // day columns carry no dates. Defaults to the Monday of the current week
    // in the VENUE's timezone (never the host's clock). A client-sent value
    // must itself be a Monday.
    const requestedWeekStart = String(req.body?.weekStart ?? '').trim();
    if (requestedWeekStart && !isMondayIso(requestedWeekStart)) return res.status(400).json({ error: WEEK_START_NOT_MONDAY_ERROR });
    const weekStart = requestedWeekStart || currentWeekStart(new Date(), await venueTimezoneFor(locationId));
    const aiConsent = String(req.body?.aiConsent ?? '') === 'true';

    let parsed: { rows: ParsedShiftRow[]; issues: RowIssue[]; templateLabel: string | null } | null = null;
    let anomalies: AnomalyRecord[] = [];
    let leaveRecords: LeaveRecord[] = [];
    let legend: { code: string; meaning: string }[] = [];
    let escalation: EscalationOutcome | undefined;

    const adopt = (result: ParsedVisionResult) => {
      parsed = { rows: result.rows, issues: result.issues, templateLabel: result.templateLabel };
      anomalies = result.anomalies;
      leaveRecords = result.leaveRecords;
      legend = result.legend;
    };

    /**
     * Gate in front of an AI read that has NO local result to fall back on. Returns the 422 body
     * to send, or null to proceed. With no provider configured nothing can be sent, so there is
     * nothing to consent to: the caller's vision entry point answers with its own local fallback
     * or `vision_unconfigured`.
     */
    const gateWithoutLocalResult = async (reason: EscalationReason) => {
      if (!getVisionProvider()) return null;
      if (!aiConsent) {
        return { error: `${ESCALATION_REASON_TEXT[reason]} ${AI_CONSENT_MESSAGE}`, errorCode: 'ai_consent_required', escalationReason: reason };
      }
      const blockReason = await checkVisionFallbackAllowed(file.size, locationId);
      return blockReason ? { error: withManualPath(blockReason), errorCode: 'vision_fallback_blocked' } : null;
    };

    /** Runs an AI read whose gate passed; records the weekly allowance only when the AI actually answered. */
    const readWithAi = async (run: () => Promise<ParsedVisionResult>) => {
      const result = await run();
      if (result.templateLabel === AI_TEMPLATE_LABEL) await markVisionFallbackUsed(locationId);
      return result;
    };

    /**
     * Escalation of a SUCCESSFUL but suspect local result (ALL-CAPS venue, many empty roles):
     * the local result stays unless the manager agreed and the AI read succeeds.
     */
    const maybeEscalate = async (local: ParsedVisionResult, run: () => Promise<ParsedVisionResult>) => {
      const reason = deterministicEscalationReason(local);
      if (!reason || !getVisionProvider()) return local;
      if (!aiConsent) {
        escalation = { reason, status: 'needs_consent', message: `${ESCALATION_REASON_TEXT[reason]} ${AI_CONSENT_MESSAGE}` };
        return local;
      }
      const blockReason = await checkVisionFallbackAllowed(file.size, locationId);
      if (blockReason) {
        escalation = { reason, status: 'unavailable', message: blockReason };
        return local;
      }
      try {
        const ai = await readWithAi(run);
        escalation = { reason, status: 'used', message: 'Read by the AI reader. Check every row before confirming.' };
        return ai;
      } catch (err) {
        if (!(err instanceof VisionIngestionError)) throw err;
        escalation = { reason, status: 'unavailable', message: `${err.message} The built-in reader's result is shown instead.` };
        return local;
      }
    };

    /** The grid parser proved it dropped real data: AI reader (with consent), else a clear 422. */
    const escalateExtractionAnomaly = async (
      anomaly: RosterExtractionAnomalyError,
      run: () => Promise<ParsedVisionResult>,
    ): Promise<{ result: ParsedVisionResult } | { status: number; body: Record<string, unknown> }> => {
      if (!getVisionProvider()) {
        return { status: 422, body: { error: withManualPath(anomaly.message), errorCode: 'roster_extraction_anomaly' } };
      }
      const gate = await gateWithoutLocalResult('extraction_anomaly');
      if (gate) return { status: 422, body: gate };
      try {
        const ai = await readWithAi(run);
        escalation = { reason: 'extraction_anomaly', status: 'used', message: 'Read by the AI reader. Check every row before confirming.' };
        return { result: ai };
      } catch (err) {
        if (err instanceof VisionIngestionError) return { status: 422, body: { error: withManualPath(err.message), errorCode: err.code } };
        throw err;
      }
    };

    const visionError = (err: unknown) => {
      if (err instanceof VisionIngestionError) return res.status(422).json({ error: withManualPath(err.message), errorCode: err.code });
      throw err;
    };

    if (isImage(file)) {
      // Arbitrary layouts (screenshots, colour-coded grids, hand-made templates):
      // nothing to parse locally, so this is the image_or_scan escalation.
      const gate = await gateWithoutLocalResult('image_or_scan');
      if (gate) return res.status(422).json(gate);
      try {
        adopt(await readWithAi(() => parseRosterImage(file.buffer, file.mimetype, file.originalname, weekStart, { locationId: req.user!.locationId })));
      } catch (err) {
        return visionError(err);
      }
    } else if (isPdf(file)) {
      // Check for a real, positioned text layer first (pdfjs-dist) — a
      // scanned/photographed PDF has none at all, and no amount of text
      // reconstruction can recover data that was never encoded as text.
      const hasTextLayer = await hasPdfTextLayer(file.buffer);
      const readPdfWithAi = (localFallback = true) => () =>
        parseRosterImage(file.buffer, 'application/pdf', file.originalname, weekStart, { localFallback, locationId: req.user!.locationId });

      if (hasTextLayer) {
        // PRIMARY path for a text-layer PDF: reconstruct the grid from real
        // character positions (no network call, fully reproducible) and reuse
        // the exact same deterministic interpreter as Excel/CSV.
        const grid = await extractPdfGrid(file.buffer);
        let gridResult: ParsedVisionResult | null = null;
        try {
          gridResult = gridParser(grid, weekStart);
        } catch (err) {
          if (!(err instanceof RosterExtractionAnomalyError)) throw err;
          const outcome = await escalateExtractionAnomaly(err, readPdfWithAi(false));
          if ('status' in outcome) return res.status(outcome.status).json(outcome.body);
          adopt(outcome.result);
        }
        if (gridResult && gridResult.templateLabel === 'Deterministic Grid Parser') {
          adopt(await maybeEscalate(gridResult, readPdfWithAi(false)));
        } else if (gridResult) {
          // Text layer present but the grid parser didn't recognise the shape — try the
          // line-oriented text parser (cheap, no API call), then the AI reader. Docling is
          // NOT tried here: it has no demonstrated value on text-layer PDFs.
          const text = await extractPdfText(file.buffer);
          const textResult = text ? parseRosterText(text, weekStart) : null;
          if (textResult && textResult.rows.length > 0) {
            parsed = { rows: textResult.rows, issues: textResult.issues, templateLabel: 'PDF Text Roster' };
          } else {
            const gate = await gateWithoutLocalResult('unrecognized_layout');
            if (gate) return res.status(422).json(gate);
            try {
              adopt(await readWithAi(readPdfWithAi()));
            } catch (err) {
              return visionError(err);
            }
          }
        }
      } else {
        // No text layer at all (scanned/photographed PDF) — try the local Docling
        // sidecar first (free and local; see doclingClient.ts for its evaluation),
        // then the AI reader.
        let doclingResult: ParsedVisionResult | null = null;
        try {
          doclingResult = await parseScannedPdfViaDocling(file.buffer, file.originalname, weekStart);
        } catch (err) {
          if (!(err instanceof DoclingUnavailableError)) throw err;
        }
        if (doclingResult) {
          console.log(
            `[schedules] PDF resolved via Docling sidecar: ${doclingResult.rows.length} rows, ${doclingResult.anomalies.length} anomalies, ${doclingResult.leaveRecords.length} leave records.`,
          );
          adopt(doclingResult);
        } else {
          const gate = await gateWithoutLocalResult('image_or_scan');
          if (gate) return res.status(422).json(gate);
          try {
            adopt(await readWithAi(readPdfWithAi()));
          } catch (err) {
            return visionError(err);
          }
        }
      }
    } else {
      try {
        const workbook = parseWorkbookBuffer(file.buffer, file.originalname);
        parsed = { rows: workbook.rows, issues: workbook.issues, templateLabel: workbook.templateLabel };
      } catch (err) {
        if (!(err instanceof TemplateDetectionError)) throw err;
        // Doesn't match any of the 3 long-format ("one row per shift") templates —
        // likely a grid-format roster (day-of-week columns, merged section headers).
        // The deterministic grid parser is the PRIMARY path for this shape; the AI
        // reader is only an escalation (see parsing/escalation.ts).
        const grid = buildMergeExpandedGrid(file.buffer, file.originalname);
        // Every parser in this app only ever reads the workbook's first sheet —
        // surfaced unconditionally whenever more than one sheet exists, since only
        // the manager can tell whether the other tabs matter.
        const otherSheetNames = listOtherSheetNames(file.buffer, file.originalname);
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
        const withSheetsNote = (result: ParsedVisionResult): ParsedVisionResult =>
          ignoredSheetsAnomaly ? { ...result, anomalies: [ignoredSheetsAnomaly, ...result.anomalies] } : result;
        const readGridWithAi = (localFallback = true) => () => parseRosterGrid(grid, file.originalname, weekStart, { localFallback, locationId: req.user!.locationId });

        let deterministicResult: ParsedVisionResult | null = null;
        try {
          deterministicResult = gridParser(grid, weekStart);
        } catch (gridErr) {
          if (!(gridErr instanceof RosterExtractionAnomalyError)) throw gridErr;
          const outcome = await escalateExtractionAnomaly(gridErr, readGridWithAi(false));
          if ('status' in outcome) return res.status(outcome.status).json(outcome.body);
          adopt(withSheetsNote(outcome.result));
        }

        if (deterministicResult && deterministicResult.templateLabel === 'Deterministic Grid Parser') {
          adopt(withSheetsNote(await maybeEscalate(deterministicResult, readGridWithAi(false))));
        } else if (deterministicResult) {
          // A layout the grid parser genuinely doesn't recognise (e.g. days-as-rows).
          const gate = await gateWithoutLocalResult('unrecognized_layout');
          if (gate) return res.status(422).json(gate);
          try {
            adopt(withSheetsNote(await readWithAi(readGridWithAi())));
          } catch (gridErr) {
            if (gridErr instanceof TemplateDetectionError) return res.status(422).json({ error: gridErr.message });
            return visionError(gridErr);
          }
        }
      }
    }

    const result = parsed as { rows: ParsedShiftRow[]; issues: RowIssue[]; templateLabel: string | null } | null;
    if (!result) throw new Error('upload: no parse result was produced');

    // For image/VLM uploads, an all-leave week (or a sheet where every cell
    // needed manager review) is a valid, non-error outcome — anomalies and
    // leaveRecords still carry useful data even with zero workable rows.
    // Only hard-reject when nothing at all came out (no rows, no anomalies,
    // no leave records, and no parse issues to surface).
    if (result.rows.length === 0 && anomalies.length === 0 && leaveRecords.length === 0 && result.issues.length === 0) {
      return res.status(422).json({
        error: withManualPath('No valid shift rows could be parsed from this file.'),
        templateDetected: result.templateLabel,
        issues: result.issues,
      });
    }

    const { previewRows, summary } = await resolveRowsAgainstDatabase(prisma, locationId, result.rows);
    const batchId = uploadCache.put(locationId, null, previewRows);

    return res.status(200).json({
      batchId,
      templateDetected: result.templateLabel,
      parseIssues: result.issues, // rows dropped before DB resolution (bad dates/times/blank fields)
      summary,
      // VLM-path metadata anomaly fallback: unresolvable cells/codes and
      // non-working-day records, for the manager-review panel. Empty arrays
      // for the Excel/CSV/PDF-text paths, which don't populate them.
      anomalies,
      leaveRecords,
      legend,
      // Present when the AI reader was used, or would help but needs consent / is unavailable.
      ...(escalation ? { escalation } : {}),
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
      // Defensive: every grid-parse site above handles this itself.
      return res.status(422).json({ error: withManualPath(err.message), errorCode: 'roster_extraction_anomaly' });
    }
    if (err instanceof MalformedPdfError) {
      // 0 bytes or bytes that aren't a PDF at all (issue #19) — a bad
      // upload, not a server fault.
      return res.status(422).json({
        error: "This file doesn't look like a valid PDF — please check it opens correctly and re-upload.",
        errorCode: 'malformed_pdf',
      });
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
 * body: {
 *   createdById?: string,
 *   edits?: { rowNumber: number; employeeName?: string; role?: string }[],
 *   removedRowNumbers?: number[],
 * }
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
 *
 * `edits`/`removedRowNumbers` back the onboarding Review screen's inline
 * name/role corrections (added alongside that screen — see
 * `src/features/onboarding/ReviewScreen.tsx`): the cached preview rows only
 * carry whatever `resolvedRoleId`/`resolvedUserId` upload-time matching
 * found, so an edited `role`/`employeeName` has to be RE-resolved here
 * before persisting, not just spliced into the display string. A `role` that
 * doesn't match any existing Role for this location is created on the fly
 * (this is also how a Review "+ Custom" role becomes a real, reusable chip
 * for the venue going forward, per product spec — a brand-new venue starts
 * with zero seeded Role rows, so even picking one of the 9 canonical chip
 * labels routinely hits this path, not just genuine custom terms).
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

    const removedRowNumbers = new Set<number>(
      Array.isArray(req.body?.removedRowNumbers) ? req.body.removedRowNumbers.filter((n: unknown) => typeof n === 'number') : [],
    );
    const editsByRow = new Map<number, { employeeName?: string; role?: string }>();
    if (Array.isArray(req.body?.edits)) {
      for (const raw of req.body.edits) {
        if (!raw || typeof raw.rowNumber !== 'number') continue;
        editsByRow.set(raw.rowNumber, {
          employeeName: typeof raw.employeeName === 'string' ? raw.employeeName : undefined,
          role: typeof raw.role === 'string' ? raw.role : undefined,
        });
      }
    }

    let rows = batch.rows.filter((r) => !removedRowNumbers.has(r.rowNumber));

    if (editsByRow.size > 0) {
      const [allRoles, users] = await Promise.all([
        prisma.role.findMany({ where: { locationId: batch.locationId } }),
        prisma.user.findMany({ where: { locationId: batch.locationId, isActive: true } }),
      ]);
      const roleByName = new Map(allRoles.filter((r) => r.isActive).map((r) => [nameKey(r.name), r.id]));
      // Deactivated roles are excluded from `roleByName` above (a deactivated
      // Role can never be a selectable chip — see GET /api/roles's identical
      // isActive: true filter) so a same-named one is never silently matched
      // and reused. Kept separately only so the create step below can
      // reactivate it instead of colliding with `@@unique([locationId,
      // name])` on a blind create.
      const inactiveRoleIdByName = new Map(allRoles.filter((r) => !r.isActive).map((r) => [nameKey(r.name), r.id]));
      const userByName = new Map(users.map((u) => [nameKey(u.fullName), u.id]));

      // Resolve every distinct brand-new role name SEQUENTIALLY, before the
      // row loop below runs at all — not inside it. The row loop used to
      // `await prisma.role.create` per-row inside a `Promise.all`, which
      // does not actually serialize anything: `Array.prototype.map` invokes
      // every callback synchronously up to its first `await`, so two rows
      // editing to the same not-yet-existing role name both read this map
      // as a miss before either create resolves, both call
      // `prisma.role.create`, and the second throws an unhandled P2002
      // (`Role` has `@@unique([locationId, name])`) that 500s the WHOLE
      // confirm — silently discarding every other row's edits too, not just
      // the colliding pair. Creating up front, one at a time, means the
      // second lookup for a repeated name always hits the map instead of
      // racing a second create.
      const neededRoleNames = new Set<string>();
      for (const edit of editsByRow.values()) {
        if (edit.role === undefined) continue;
        const trimmed = edit.role.trim();
        if (!trimmed) continue;
        const canonical = canonicalRoleName(trimmed);
        if (roleByName.has(nameKey(trimmed)) || roleByName.has(nameKey(canonical))) continue;
        neededRoleNames.add(canonical);
      }
      for (const name of neededRoleNames) {
        const key = nameKey(name);
        if (roleByName.has(key)) continue; // an earlier name in this same loop already created an equivalent role
        const inactiveId = inactiveRoleIdByName.get(key);
        if (inactiveId) {
          // A deactivated Role already owns this exact name — create would
          // 500 on the @@unique([locationId, name]) index. Reactivate it
          // instead of reusing it as-is, so it starts showing up as a
          // selectable chip again like any other active role.
          const reactivated = await prisma.role.update({ where: { id: inactiveId }, data: { isActive: true } });
          roleByName.set(key, reactivated.id);
          continue;
        }
        const created = await prisma.role.create({ data: { locationId: batch.locationId, name } });
        roleByName.set(key, created.id);
      }

      rows = rows.map((row) => {
        const edit = editsByRow.get(row.rowNumber);
        if (!edit) return row;
        const next = { ...row };

        if (edit.employeeName !== undefined) {
          const trimmed = edit.employeeName.trim();
          if (trimmed) {
            next.employeeName = trimmed;
            next.resolvedUserId = userByName.get(nameKey(trimmed)) ?? null;
          }
        }

        if (edit.role !== undefined) {
          const trimmed = edit.role.trim();
          if (trimmed) {
            next.roleName = trimmed;
            next.resolvedRoleId = roleByName.get(nameKey(trimmed)) ?? roleByName.get(nameKey(canonicalRoleName(trimmed))) ?? null;
          }
        }

        return next;
      });
    }

    const result = await withAuditedTransaction(
      prisma,
      (tx) => persistShifts(tx, batch.locationId, createdById, rows),
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
