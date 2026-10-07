import { createHash } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { visionWeeklyLimit } from '../lib/aiBudget.js';
import { parseExcelGrid, RosterExtractionAnomalyError } from '../parsing/deterministicGridParser.js';
import { MalformedPdfError } from '../parsing/pdfTableExtractor.js';
import { isIsoDate, isMondayIso, venueDateOf, WEEK_START_NOT_MONDAY_ERROR } from '../lib/venueWeek.js';
import { venueTimezoneFor } from '../lib/venueTime.js';
import { AI_READ_BUDGET_MS } from '../parsing/parseVision.js';
import { getVisionProvider } from '../parsing/visionProvider.js';
import { readUploadedRoster, withManualPath } from '../parsing/readUpload.js';
import type { ReadProgressEvent } from '../parsing/readProgress.js';
import { prismaReadingCache, type ReadingCache } from '../parsing/readingCache.js';
import { resolveRowsAgainstDatabase, nameKey, canonicalRoleName, buildPeoplePreview, loadVenueMatchContext } from '../parsing/resolveRows.js';
import { persistRosterImport, RosterImportError, mondayOfIso } from '../parsing/persistShifts.js';
import type { AddedPerson, ConfirmPersonDecision, PersonPreview } from '../parsing/rosterContract.js';
import { uploadCache } from '../store/uploadCache.js';
import { uploadProgress, type UploadOwner } from '../store/uploadProgress.js';
import { requireSession, requireManager, ownedOrNotFound, bearerToken } from '../middleware/requireSession.js';
import { rosterUploadRateLimiter } from '../middleware/rateLimit.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { notifySchedulePublished, mondayOfWeek } from '../lib/scheduleNotifications.js';

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Guards on the paid vision-fallback path only (hosted Gemini/Vertex AI
// call for image/scanned-PDF uploads) — the deterministic Excel/CSV/
// text-layer-PDF path is unaffected by either limit.
const VISION_FALLBACK_MAX_BYTES = 5 * 1024 * 1024;
const VISION_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** This venue's AI reads within the rolling 7-day window, oldest first. */
function recentVisionUses(uses: Date[], now = Date.now()): Date[] {
  return uses.filter((d) => now - d.getTime() < VISION_FALLBACK_WINDOW_MS).sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Returns a user-facing rejection message when the vision-fallback path
 * shouldn't run for this upload (file too large, or this venue already used
 * its `AI_VISION_WEEKLY_LIMIT` reads in the last 7 days) — null when it's
 * allowed to proceed.
 */
async function checkVisionFallbackAllowed(fileSize: number, locationId: string): Promise<string | null> {
  if (fileSize > VISION_FALLBACK_MAX_BYTES) {
    return `This file is ${(fileSize / (1024 * 1024)).toFixed(1)}MB, over the ${VISION_FALLBACK_MAX_BYTES / (1024 * 1024)}MB limit for AI-assisted roster reading. Please upload a smaller image/PDF, or use an Excel/CSV export instead.`;
  }
  const limit = visionWeeklyLimit();
  if (limit === 0) return 'AI-assisted roster reading is switched off on this server. Try an Excel/CSV export instead.';
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { visionFallbackUses: true } });
  const recent = recentVisionUses(location?.visionFallbackUses ?? []);
  if (recent.length >= limit) {
    const lastUsed = recent[recent.length - 1]!;
    const nextAvailable = new Date(recent[recent.length - limit]!.getTime() + VISION_FALLBACK_WINDOW_MS);
    return (
      `AI-assisted roster reading for this venue was already used this week ` +
      `(last used ${lastUsed.toISOString().slice(0, 10)}) — it's limited to ${limit === 1 ? 'once' : `${limit} times`} per venue per week. ` +
      `It'll be available again on ${nextAvailable.toISOString().slice(0, 10)}. Try an Excel/CSV export in the meantime.`
    );
  }
  return null;
}

/** Records one use of this venue's weekly vision-fallback allowance. Call only after a successful parse. */
async function markVisionFallbackUsed(locationId: string): Promise<void> {
  const now = new Date();
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { visionFallbackUses: true } });
  const kept = recentVisionUses(location?.visionFallbackUses ?? [], now.getTime());
  await prisma.location.update({ where: { id: locationId }, data: { lastVisionFallbackUsedAt: now, visionFallbackUses: [...kept, now] } });
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

/** The AI-reading cache the upload route uses (per venue, by file hash). A test seam may swap it. */
let readingCache: ReadingCache | null = prismaReadingCache;
export function __setReadingCacheForTests(cache: ReadingCache | null | undefined): void {
  readingCache = cache === undefined ? prismaReadingCache : cache;
}

/**
 * How long one upload may spend on AI reads, every call and the re-read pass included: inside the
 * ~120 s the web proxy in front of the API waits for an answer (ROSTER_AI_BUDGET_MS overrides).
 */
function aiBudgetMs(): number {
  const n = Number(process.env.ROSTER_AI_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : AI_READ_BUDGET_MS;
}

/** Who may follow an upload's progress: its venue and its session (a hash of the token; the token itself is never kept). */
function progressOwner(req: Request): UploadOwner {
  return { locationId: req.user!.locationId, sessionKey: createHash('sha256').update(bearerToken(req) ?? '').digest('hex') };
}

/**
 * Starts following an upload sent with `X-Upload-Id` (a UUID the client picked), before its body
 * is read — so "Uploading" is the server's word too — and marks it done or failed when the
 * response is sent (or the client goes away). An upload without the header is simply not followed.
 */
const trackUploadProgress: RequestHandler = (req, res, next) => {
  const id = String(req.get('x-upload-id') ?? '').trim();
  if (id && uploadProgress.start(id, progressOwner(req))) {
    res.locals.uploadId = id;
    res.on('close', () => uploadProgress.advance(id, res.writableFinished && res.statusCode < 400 ? 'done' : 'failed'));
  }
  next();
};

/**
 * GET /api/schedules/upload-progress/:uploadId — where an upload sent with `X-Upload-Id` is:
 * `{ stage, passed, pages, secondRead }` (store/uploadProgress.ts). Only the venue and session that
 * started it: another venue's id (or an unknown one) is a 404 `upload_progress_unknown`, another
 * session's a 403. Polled about once a second while the upload request is open; stages and page
 * counts only, never a name. In memory on this instance (see the store for what that means).
 */
schedulesRouter.get('/upload-progress/:uploadId', requireSession, requireManager, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const found = uploadProgress.read(req.params.uploadId, progressOwner(req));
  if (found.status === 'not_found') return res.status(404).json({ error: 'No upload with that id is being read.', errorCode: 'upload_progress_unknown' });
  if (found.status === 'forbidden') return res.status(403).json({ error: 'That upload was started from another session.' });
  return res.status(200).json(found.view);
});

/**
 * POST /api/schedules/upload
 * multipart/form-data: file=<xlsx|xls|csv|pdf|image>, weekStart?=YYYY-MM-DD (a Monday),
 * aiConsent?="true" (the manager agreed to send THIS file to the AI reader).
 *
 * How each kind of file is read lives in parsing/readUpload.ts: spreadsheets deterministically
 * (the AI reader only for one of the reasons in parsing/escalation.ts), text-layer PDFs by the
 * AI reader cross-checked by the table reader, photos and scans by the AI reader. A file goes
 * to the AI reader only when a provider is configured, and only with `aiConsent` — without it
 * the answer is a 422 `ai_consent_required` (nothing sent) or, when a local result exists, that
 * result plus `escalation.status: 'needs_consent'`. The 5 MB cap and the per-venue weekly
 * allowance apply to every AI read; a file read before at this venue is answered from the
 * cache (no call, no allowance). Dates come from what the roster prints; a client `weekStart`
 * is used only when it prints none. Nothing is written to the roster here: the response is a
 * preview with a `batchId` for the confirm step below, plus every person read (`readPeople`),
 * rows that couldn't be read (`unreadRows`), the detected `week` and a `reading` report.
 * Manager/owner sessions only (like confirm): an AI read costs the venue money and allowance.
 */
schedulesRouter.post('/upload', requireSession, requireManager, rosterUploadRateLimiter, trackUploadProgress, upload.single('file'), async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const uploadId = res.locals.uploadId as string | undefined;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Attach it under the "file" field.' });
    }
    const file = req.file;

    // A client-sent week is used only when the roster prints no dates (weekDetection.ts), and
    // must itself be a Monday. Without one, a roster printing only weekday names lands in the
    // coming week and the review screen asks the manager to confirm it.
    const requestedWeekStart = String(req.body?.weekStart ?? '').trim();
    if (requestedWeekStart && !isMondayIso(requestedWeekStart)) return res.status(400).json({ error: WEEK_START_NOT_MONDAY_ERROR });
    const timezone = await venueTimezoneFor(locationId);
    const aiConsent = String(req.body?.aiConsent ?? '') === 'true';

    const outcome = await readUploadedRoster(file, {
      locationId,
      userId: req.user!.id,
      today: venueDateOf(new Date(), timezone),
      clientWeekStart: requestedWeekStart || null,
      aiConsent,
      provider: getVisionProvider(),
      aiBlockedReason: () => checkVisionFallbackAllowed(file.size, locationId),
      markAiUsed: () => markVisionFallbackUsed(locationId),
      cache: readingCache,
      deadline: Date.now() + aiBudgetMs(),
      gridParser,
      ...(uploadId ? { onProgress: (event: ReadProgressEvent) => uploadProgress.report(uploadId, event) } : {}),
    });
    if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
    const { result, reading, escalation } = outcome;
    const { anomalies, leaveRecords, legend } = result;
    console.log(
      `[schedules.upload] read: ${result.rows.length} shifts, ${result.people?.length ?? 0} people, ${result.unreadRows?.length ?? 0} unread rows, ` +
        `ai=${reading.ai} table=${reading.table} disagreements=${reading.disagreements} week=${result.week.source}`,
    );

    // For image/VLM uploads, an all-leave week (or a sheet where every cell
    // needed manager review) is a valid, non-error outcome — anomalies and
    // leaveRecords still carry useful data even with zero workable rows.
    // Only hard-reject when nothing at all came out (no rows, no anomalies,
    // no leave records, no parse issues, nobody read and no row left unread).
    if (
      result.rows.length === 0 &&
      anomalies.length === 0 &&
      leaveRecords.length === 0 &&
      result.issues.length === 0 &&
      (result.people?.length ?? 0) === 0 &&
      (result.unreadRows?.length ?? 0) === 0
    ) {
      return res.status(422).json({
        error: withManualPath('No valid shift rows could be parsed from this file.'),
        templateDetected: result.templateLabel,
        issues: result.issues,
      });
    }

    if (uploadId) uploadProgress.advance(uploadId, 'matching');
    const { previewRows, summary, people } = await resolveRowsAgainstDatabase(prisma, locationId, result.rows, { readPeople: result.people });
    const batchId = uploadCache.put(locationId, null, previewRows, { people });

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
      // Reading (rosterContract.ts): every person read (people with no shifts included), rows
      // that couldn't be read, the week the roster prints, and what each reader did.
      readPeople: result.people ?? [],
      unreadRows: result.unreadRows ?? [],
      week: result.week,
      reading,
      // Present when the AI reader was used, or would help but needs consent / is unavailable.
      ...(escalation ? { escalation } : {}),
      // One entry per person on the roster (the review screen's unit); summary.people counts them.
      people,
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
        ...(r.personKey ? { personKey: r.personKey } : {}),
        ...(r.section !== undefined ? { section: r.section } : {}),
        ...(r.sourcePage !== undefined ? { sourcePage: r.sourcePage } : {}),
        ...(r.readerSource ? { readerSource: r.readerSource } : {}),
        ...(r.flags?.length ? { flags: r.flags } : {}),
        ...(r.alternatives?.length ? { alternatives: r.alternatives } : {}),
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


const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const CONFIRM_DECISION_ACTIONS = new Set(['create', 'link', 'skip']);

/** Validates `people` from a confirm body; a string is the 400 message. */
function parsePersonDecisions(raw: unknown, people: PersonPreview[]): Map<string, ConfirmPersonDecision> | string {
  const decisions = new Map<string, ConfirmPersonDecision>();
  if (raw === undefined || raw === null) return decisions;
  if (!Array.isArray(raw)) return '"people" must be a list of decisions.';
  const known = new Set(people.map((p) => p.personKey));
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return 'Each entry in "people" must be an object.';
    const { personKey, action, userId, name, roleName } = entry as Record<string, unknown>;
    if (typeof personKey !== 'string' || !known.has(personKey)) return 'A decision names a person who is not in this roster. Please re-upload the file.';
    if (typeof action !== 'string' || !CONFIRM_DECISION_ACTIONS.has(action)) return `Unknown action for a person: use create, link or skip.`;
    if (action === 'link' && (typeof userId !== 'string' || !userId)) return 'Linking a person needs the staff member (userId).';
    if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 120)) return 'A name must be text, up to 120 characters.';
    if (roleName !== undefined && roleName !== null && (typeof roleName !== 'string' || roleName.length > 80)) return 'A role must be text, up to 80 characters.';
    decisions.set(personKey, {
      personKey,
      action: action as ConfirmPersonDecision['action'],
      ...(typeof userId === 'string' ? { userId } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      ...(roleName === null || typeof roleName === 'string' ? { roleName } : {}),
    });
  }
  return decisions;
}

/** Validates `addedPeople` from a confirm body; a string is the 400 message. */
function parseAddedPeople(raw: unknown): AddedPerson[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return '"addedPeople" must be a list.';
  if (raw.length > 200) return 'Too many people added at once.';
  const added: AddedPerson[] = [];
  for (const entry of raw) {
    const { name, roleName } = (entry ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) return 'Each added person needs a name (up to 120 characters).';
    if (roleName !== undefined && roleName !== null && (typeof roleName !== 'string' || roleName.length > 80)) return 'A role must be text, up to 80 characters.';
    added.push({ name: name.trim(), roleName: typeof roleName === 'string' && roleName.trim() ? roleName.trim() : null });
  }
  return added;
}

/**
 * POST /api/schedules/upload/:batchId/confirm
 * body: {
 *   createdById?: string,
 *   weekStart?: string,                 // ISO Monday the manager confirmed; shifts move by the whole weeks between it and the roster's own week
 *   people?: ConfirmPersonDecision[],   // per personKey: create (new staff) | link (existing staff, userId) | skip
 *   addedPeople?: AddedPerson[],        // "add missing person" (no shifts)
 *   rememberRoleMappings?: boolean,     // save printed role label -> role for labels assigned by hand
 *   edits?: { rowNumber: number; employeeName?: string; role?: string; startTime?: string; endTime?: string; overnight?: boolean }[],
 *   removedRowNumbers?: number[],
 * }
 *
 * Commits a reviewed batch (see parsing/persistShifts.ts's persistRosterImport): every person
 * not skipped becomes or links to a real staff member and gets their shifts; nobody is dropped
 * for an unresolved role. Idempotent: confirming the same roster again creates no staff and no
 * shifts (identical shifts are counted in `skippedDuplicates`; a different shift overlapping one
 * the person already has is listed in `overlaps`, not written). A person with no decision gets
 * the conservative default (exact name match -> link, else create), so older clients that send
 * only `edits`/`removedRowNumbers` keep working. Linking to someone outside the caller's venue
 * is a 400. Manager/owner sessions only; the batch must belong to the caller's venue
 * (2026-09-05: this was requireSession-only, so a STAFF session could bulk-create shifts).
 *
 * `edits`/`removedRowNumbers` back the review screen's per-row corrections: an edited
 * `role`/`employeeName` is RE-resolved here, not just spliced into the display string, and a
 * `role` that matches no existing Role is created on the fly (canonical name; a deactivated
 * one is reactivated). `startTime`/`endTime` carry the manager's pick when the two readers
 * read different times.
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

    const requestedWeekStart = typeof req.body?.weekStart === 'string' ? req.body.weekStart.trim() : '';
    if (requestedWeekStart && !isMondayIso(requestedWeekStart)) return res.status(400).json({ error: WEEK_START_NOT_MONDAY_ERROR });

    const removedRowNumbers = new Set<number>(
      Array.isArray(req.body?.removedRowNumbers) ? req.body.removedRowNumbers.filter((n: unknown) => typeof n === 'number') : [],
    );
    const editsByRow = new Map<number, { employeeName?: string; role?: string; startTime?: string; endTime?: string; overnight?: boolean }>();
    if (Array.isArray(req.body?.edits)) {
      for (const raw of req.body.edits) {
        if (!raw || typeof raw.rowNumber !== 'number') continue;
        editsByRow.set(raw.rowNumber, {
          employeeName: typeof raw.employeeName === 'string' ? raw.employeeName : undefined,
          role: typeof raw.role === 'string' ? raw.role : undefined,
          startTime: typeof raw.startTime === 'string' && HHMM.test(raw.startTime) ? raw.startTime : undefined,
          endTime: typeof raw.endTime === 'string' && HHMM.test(raw.endTime) ? raw.endTime : undefined,
          overnight: typeof raw.overnight === 'boolean' ? raw.overnight : undefined,
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

        if (edit.startTime) next.startTime = edit.startTime;
        if (edit.endTime) next.endTime = edit.endTime;
        if (edit.startTime || edit.endTime || edit.overnight !== undefined) next.overnight = edit.overnight ?? next.endTime <= next.startTime;

        return next;
      });
    }

    // The batch's people. Re-derived from the (edited) rows when the cache predates people, or
    // when an older client renamed rows instead of sending per-person decisions.
    const renamedRows = [...editsByRow.values()].some((e) => e.employeeName?.trim());
    const usePersonDecisions = Array.isArray(req.body?.people);
    let people: PersonPreview[] = batch.people ?? [];
    if (!batch.people || (renamedRows && !usePersonDecisions)) {
      const derived = buildPeoplePreview(rows, undefined, await loadVenueMatchContext(prisma, batch.locationId));
      people = [...derived, ...(batch.people ?? []).filter((p) => p.shiftCount === 0)];
    }

    const decisions = parsePersonDecisions(req.body?.people, people);
    if (typeof decisions === 'string') return res.status(400).json({ error: decisions });
    const addedPeople = parseAddedPeople(req.body?.addedPeople);
    if (typeof addedPeople === 'string') return res.status(400).json({ error: addedPeople });

    // The manager confirmed a different week than the one the shifts are dated in: move every
    // shift by the same whole number of weeks, so they land in the roster's printed week.
    const dates = rows.map((r) => r.date).filter(isIsoDate).sort();
    const detectedWeekStart = dates.length > 0 ? mondayOfIso(dates[0]!) : null;
    const weekDeltaDays =
      requestedWeekStart && detectedWeekStart ? Math.round((Date.parse(`${requestedWeekStart}T00:00:00Z`) - Date.parse(`${detectedWeekStart}T00:00:00Z`)) / 86_400_000) : 0;

    const result = await withAuditedTransaction(
      prisma,
      (tx) =>
        persistRosterImport(tx, {
          locationId: batch.locationId,
          actorId: req.user!.id,
          createdById,
          rows,
          people,
          decisions,
          addedPeople,
          weekDeltaDays,
          rememberRoleMappings: req.body?.rememberRoleMappings === true,
        }),
      // Only write a real audit row when at least one shift was actually
      // created — a confirm that wrote nothing (every person skipped, every
      // shift already on the rota) would otherwise produce a SHIFT_CREATED
      // entry pointing at no real Shift. New staff get their own
      // STAFF_CREATED rows inside the import.
      (persisted) =>
        persisted.createdShifts > 0
          ? {
              locationId: batch.locationId,
              actorId: req.user!.id,
              action: 'SHIFT_CREATED',
              entityType: 'Shift',
              entityId: persisted.rows[0]!.shiftId,
              shiftId: persisted.rows[0]!.shiftId,
              note:
                `Imported ${persisted.createdShifts} shift(s) from roster upload ` +
                `(${persisted.createdPeople} new staff, ${persisted.linkedPeople} existing, ${persisted.skippedDuplicates} already on the rota, ` +
                `${persisted.overlaps.length} overlapping, ${persisted.skippedPeople} people skipped)`,
            }
          : null,
      // A big roster is a few hundred rows; the default 5s is too tight against a remote database.
      { maxWait: 10_000, timeout: 30_000 },
    );
    // Deleted only after the transaction commits — deleting it before commit
    // and then having the transaction roll back (e.g. the audit write fails)
    // would permanently strand the batch as unretryable with nothing
    // actually persisted. A second confirm racing this one is safe: the
    // import holds a per-venue lock and is idempotent (see persistRosterImport).
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

    const { rows: persistedRows, skippedRowCount, ...outcome } = result;
    return res.status(201).json({
      message: `Imported ${result.createdShifts} shift(s): ${result.createdPeople} new staff, ${result.linkedPeople} already on staff.`,
      createdCount: result.createdShifts,
      skippedCount: skippedRowCount,
      rows: persistedRows,
      ...outcome,
    });
  } catch (err) {
    if (err instanceof RosterImportError) return res.status(err.status).json({ error: err.message });
    console.error('[schedules.confirm] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving shifts.' });
  }
});
