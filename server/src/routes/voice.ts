import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager } from '../middleware/requireSession.js';
import { transcribeRateLimiter, parseIntentRateLimiter } from '../middleware/rateLimit.js';
import { transcribeAudio, VoiceTranscriptionError } from '../voice/transcribe.js';
import { parseVoiceIntent, VoiceIntentError } from '../voice/parseIntent.js';
import { logParsedInteraction, shouldPromptForAdditionalRequest } from '../voice/interactionLog.js';
import { allowedIntentsFor, MANAGER_INTENTS, type ParsedIntent } from '../voice/intentSchema.js';
import { createSwapRequest, decideSwapRequest, notifySwapRequested, notifySwapDecided } from '../lib/actions/swapActions.js';
import { decideJoinRequest } from '../lib/actions/joinActions.js';
import { markAvailability } from '../lib/actions/availabilityActions.js';
import { writeAuditLog, withAuditedTransaction } from '../lib/auditLog.js';
import { createShift, editShift } from '../lib/actions/shiftActions.js';
import { upsertSectionAssignment } from '../lib/actions/sectionActions.js';
import { publishRota, applyRotaTemplate } from '../lib/actions/rotaActions.js';
import { createAnnouncement, createShoutout } from '../lib/actions/communicationActions.js';
import { notifySchedulePublished } from '../lib/scheduleNotifications.js';
import { updateInteractionOutcome } from '../voice/interactionLog.js';
import { combineDateAndTime } from '../parsing/normalize.js';
import { formatVenueTime, venueTimezoneFor } from '../lib/venueTime.js';
import { canSeeDraftShifts } from '../lib/shiftVisibility.js';
import { findBlockingLeave, blockedByLeaveMessage } from '../lib/actions/leaveActions.js';

export const voiceRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Every intent value /execute can ever legitimately see: the full manager
 * set (already a strict superset of the staff set — see intentSchema.ts)
 * plus the model's own "couldn't confidently resolve this" signal. Used
 * ONLY to distinguish "not a real intent at all" (400) from "a real intent
 * your role doesn't permit" (403) — see the ordering note in /execute below.
 */
const ALL_INTENTS: readonly string[] = [...MANAGER_INTENTS, 'UNRECOGNIZED'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * What the END USER is told when the Gemini-backed half of the pipeline is
 * unavailable. VoiceTranscriptionError/VoiceIntentError messages are written
 * for OPERATORS — they name internals ("GEMINI_API_KEY is not configured on
 * the server…", raw upstream status codes and provider messages) — and were
 * previously returned verbatim, so an env-var name surfaced in the app's own
 * error banner. The detailed message still goes to the server log below;
 * only this generic line crosses the wire.
 */
const VOICE_UNAVAILABLE = "Voice commands aren't available right now — try again later.";

/**
 * Per-intent-type shape guard for the CLIENT-SUPPLIED intent body — mirrors
 * the narrowing style parseIntent.ts's normalizeParsedIntent already uses
 * for Gemini's own output, just applied here to whatever a caller's request
 * body actually contains (which, unlike Gemini's schema-constrained output,
 * is NOT structurally trustworthy at all). A malformed field here is not a
 * security bypass — Prisma's own validation would reject it too — but
 * letting it fall through to a raw Prisma call turns a bad request into an
 * indistinguishable 500 with a full stack trace in the server log. This
 * returns a real 400 instead, before any Prisma call is made.
 */
function validateIntentShape(intent: ParsedIntent): string | null {
  switch (intent.intent) {
    case 'MARK_AVAILABILITY': {
      if (!DATE_RE.test(intent.date)) return 'date must be YYYY-MM-DD.';
      // The regex above is a SHAPE check only — it accepts '9999-99-99' and
      // '0000-00-00' (which crash `new Date(...)` downstream, or worse,
      // '2026-02-30', which JS silently rolls over to March 2nd instead of
      // rejecting. A round-trip through Date and back to YYYY-MM-DD catches
      // both: an invalid date, or a date that got silently renormalized to a
      // DIFFERENT day than what was asked for.
      const d = new Date(`${intent.date}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== intent.date) {
        return 'date must be a real calendar date (YYYY-MM-DD).';
      }
      if (intent.type !== 'UNAVAILABLE' && intent.type !== 'PREFERRED_OFF') {
        return 'type must be "UNAVAILABLE" or "PREFERRED_OFF".';
      }
      return null;
    }
    case 'REQUEST_SWAP':
      if (!isNonEmptyString(intent.shiftId)) return 'shiftId is required.';
      if (!isNonEmptyString(intent.targetUserId)) return 'targetUserId is required.';
      if (intent.reason !== null && intent.reason !== undefined && typeof intent.reason !== 'string') {
        return 'reason must be a string or null.';
      }
      return null;
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      if (!isNonEmptyString(intent.swapRequestId)) return 'swapRequestId is required.';
      return null;
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      if (!isNonEmptyString(intent.joinRequestId)) return 'joinRequestId is required.';
      return null;
    case 'CREATE_SHIFT': {
      if (!isNonEmptyString(intent.roleId)) return 'roleId is required.';
      if (!DATE_RE.test(intent.date)) return 'date must be YYYY-MM-DD.';
      const d = new Date(`${intent.date}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== intent.date) {
        return 'date must be a real calendar date (YYYY-MM-DD).';
      }
      if (!TIME_RE.test(intent.start) || !TIME_RE.test(intent.end)) return 'start/end must be HH:MM.';
      return null;
    }
    case 'EDIT_SHIFT': {
      if (!isNonEmptyString(intent.shiftId)) return 'shiftId is required.';
      if (intent.date !== undefined && !DATE_RE.test(intent.date)) return 'date must be YYYY-MM-DD.';
      if (intent.start !== undefined && !TIME_RE.test(intent.start)) return 'start must be HH:MM.';
      if (intent.end !== undefined && !TIME_RE.test(intent.end)) return 'end must be HH:MM.';
      return null;
    }
    case 'ASSIGN_SECTION': {
      if (!isNonEmptyString(intent.sectionId)) return 'sectionId is required.';
      if (!isNonEmptyString(intent.staffId)) return 'staffId is required.';
      if (!DATE_RE.test(intent.shiftDate)) return 'shiftDate must be YYYY-MM-DD.';
      if (intent.period !== 'AM' && intent.period !== 'PM') return 'period must be "AM" or "PM".';
      return null;
    }
    case 'PUBLISH_ROTA': {
      if (!DATE_RE.test(intent.weekStart)) return 'weekStart must be YYYY-MM-DD.';
      const d = new Date(`${intent.weekStart}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== intent.weekStart) {
        return 'weekStart must be a real calendar date (YYYY-MM-DD).';
      }
      return null;
    }
    case 'APPLY_ROTA_TEMPLATE': {
      if (!isNonEmptyString(intent.templateId)) return 'templateId is required.';
      if (!DATE_RE.test(intent.weekStart)) return 'weekStart must be YYYY-MM-DD.';
      const d = new Date(`${intent.weekStart}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== intent.weekStart) {
        return 'weekStart must be a real calendar date (YYYY-MM-DD).';
      }
      return null;
    }
    case 'POST_ANNOUNCEMENT':
      if (!isNonEmptyString(intent.content)) return 'content is required.';
      return null;
    case 'POST_SHOUTOUT':
      if (!isNonEmptyString(intent.targetUserId)) return 'targetUserId is required.';
      if (!isNonEmptyString(intent.content)) return 'content is required.';
      return null;
    case 'UNRECOGNIZED':
      return null;
    default:
      return null;
  }
}

/**
 * POST /api/voice/transcribe — multipart: audio. Session-gated only so this
 * can't be used as an open transcription proxy. Passes through whatever
 * mimetype the upload declares — Gemini's documented audio-input formats do
 * NOT include audio/webm (the browser MediaRecorder default), and resolving
 * that gap belongs to the recording client, not this endpoint.
 */
voiceRouter.post('/transcribe', requireSession, transcribeRateLimiter, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });

    // The vocabulary hint is purely an accuracy optimization, not a
    // requirement — this endpoint previously touched no database at all.
    // Isolate the lookups so a transient DB blip degrades to "transcription
    // without the vocabulary boost" instead of failing the whole request.
    let vocabulary: string | undefined;
    try {
      const [staff, sections, roles] = await Promise.all([
        prisma.user.findMany({ where: { locationId: req.user!.locationId, isActive: true }, select: { fullName: true } }),
        prisma.floorSection.findMany({ where: { locationId: req.user!.locationId }, select: { label: true } }),
        prisma.role.findMany({ where: { locationId: req.user!.locationId }, select: { name: true } }),
      ]);
      const vocabularyTerms = [
        ...staff.map((s) => s.fullName),
        ...sections.map((s) => s.label),
        ...roles.map((r) => r.name),
        'rota', 'floor', 'section', 'swap', 'cover', 'shift',
      ];
      // Cap (and, as a side effect, de-dupe via Set) so a venue with hundreds
      // of staff/sections/roles doesn't blow up the prompt appended to every
      // transcription — this is a hint, not a directory.
      vocabulary = [...new Set(vocabularyTerms)].slice(0, 150).join(', ');
    } catch (vocabErr) {
      console.error('[voice.transcribe] failed to build vocabulary hint, transcribing without it', vocabErr);
      vocabulary = undefined;
    }

    const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype, vocabulary);
    return res.status(200).json({ transcript });
  } catch (err) {
    if (err instanceof VoiceTranscriptionError) {
      console.error('[voice.transcribe] unavailable', err);
      return res.status(503).json({ error: VOICE_UNAVAILABLE });
    }
    console.error('[voice.transcribe] failed', err);
    return res.status(500).json({ error: 'Unexpected error while transcribing audio.' });
  }
});

/** POST /api/voice/parse-intent — body: { transcript }. Never mutates anything — the "propose" half of confirm-before-execute. */
voiceRouter.post('/parse-intent', requireSession, parseIntentRateLimiter, async (req, res) => {
  try {
    const transcript = String(req.body?.transcript ?? '').trim();
    if (!transcript) return res.status(400).json({ error: 'transcript is required.' });

    const resolution = await parseVoiceIntent(transcript, {
      id: req.user!.id,
      systemRole: req.user!.systemRole,
      fullName: req.user!.fullName,
      locationId: req.user!.locationId,
    });
    // Logging the interaction is observability, not the confirm-before-execute
    // flow itself — a successfully-parsed command must still reach the user
    // for confirmation even if this write fails (e.g. a transient DB error).
    // Isolate it from the handler's generic catch below so a logging failure
    // degrades to voiceLogId: null instead of masquerading as a parse failure
    // via a misleading 500. /execute (Task 9) treats a missing/null
    // voiceLogId as "skip the log update, proceed normally".
    let voiceLogId: string | null = null;
    try {
      voiceLogId = await logParsedInteraction({ id: req.user!.id, locationId: req.user!.locationId }, transcript, resolution);
    } catch (logErr) {
      console.error('[voice.parseIntent] failed to write interaction log', logErr);
    }
    return res.status(200).json({
      transcript,
      intent: resolution.response,
      voiceLogId,
      hasAdditionalRequest: shouldPromptForAdditionalRequest(resolution),
    });
  } catch (err) {
    if (err instanceof VoiceIntentError) {
      console.error('[voice.parseIntent] unavailable', err);
      return res.status(503).json({ error: VOICE_UNAVAILABLE });
    }
    console.error('[voice.parseIntent] failed', err);
    return res.status(500).json({ error: 'Unexpected error while parsing the voice command.' });
  }
});

/**
 * POST /api/voice/execute — body: { transcript, intent: ParsedIntent }.
 * The "execute" half. Re-derives role from session (never trusts that
 * /parse-intent already scoped this correctly — a client could call this
 * directly with a hand-crafted intent) and re-validates every referenced
 * entity fresh before writing anything.
 *
 * THIS IS THE ONLY REAL SECURITY BOUNDARY IN THE VOICE FEATURE. Everything
 * upstream (the Gemini response-schema restriction in /parse-intent) is
 * enforcement by the model, not a structural guarantee — a client can call
 * this endpoint directly with a hand-crafted body, bypassing /parse-intent
 * entirely. The role-permission check below MUST hold on its own.
 */
voiceRouter.post('/execute', requireSession, async (req, res) => {
  const transcript = String(req.body?.transcript ?? '');
  const intent = req.body?.intent as ParsedIntent | undefined;
  const voiceLogId = typeof req.body?.voiceLogId === 'string' ? req.body.voiceLogId : null;

  /**
   * Every response path in this handler routes through here so
   * VoiceInteractionLog's outcome always reflects what actually happened —
   * a caller that never sent a voiceLogId (a hand-crafted request) still
   * gets the normal response, just with no log row to update.
   */
  const respond = async (
    status: number,
    body: Record<string, unknown>,
    outcome: 'EXECUTED' | 'REJECTED_VALIDATION' | 'REJECTED_PERMISSION' | 'ERROR',
    declineReason?: string,
  ) => {
    if (voiceLogId) {
      await updateInteractionOutcome(voiceLogId, req.user!.id, outcome, declineReason).catch((err) =>
        console.error('[voice.execute] failed to update interaction log', err),
      );
    }
    return res.status(status).json(body);
  };

  try {
    if (!intent || typeof intent.intent !== 'string') {
      return respond(400, { error: 'A parsed intent is required.' }, 'REJECTED_VALIDATION', 'A parsed intent is required.');
    }

    // Check membership in the FULL known intent set FIRST, before the
    // role-permission check runs — this is what makes the switch's own
    // `default: … 400 'Unknown intent.'` branch below reachable at all.
    // Without this ordering, a garbage/unknown intent string fell through
    // to the same misleading 403 as a real-but-not-permitted intent
    // ("Your role does not permit the \"DELETE_EVERYTHING\" action.").
    if (!ALL_INTENTS.includes(intent.intent)) {
      const msg = `"${intent.intent}" is not a recognized voice command.`;
      return respond(400, { error: msg }, 'REJECTED_VALIDATION', msg);
    }

    // 'UNRECOGNIZED' is exempt from the role-permission check: it is not a
    // real, role-restricted action (it's the model's own "I couldn't
    // confidently resolve this" signal), and it is deliberately absent from
    // both allowedIntentsFor()'s STAFF_INTENTS/MANAGER_INTENTS arrays — those
    // only ever list real actions. Without this exemption, a legitimate
    // UNRECOGNIZED parse would be misreported as a 403 permission error
    // instead of reaching its own dedicated 400 branch in the switch below.
    const allowed = allowedIntentsFor(req.user!.systemRole);
    if (intent.intent !== 'UNRECOGNIZED' && !allowed.includes(intent.intent as (typeof allowed)[number])) {
      const msg = `Your role does not permit the "${intent.intent}" action.`;
      return respond(403, { error: msg }, 'REJECTED_PERMISSION', msg);
    }

    const shapeError = validateIntentShape(intent);
    if (shapeError) return respond(400, { error: shapeError }, 'REJECTED_VALIDATION', shapeError);

    const note = `[voice] "${transcript}"`;
    const actorId = req.user!.id;
    const locationId = req.user!.locationId;

    switch (intent.intent) {
      case 'MARK_AVAILABILITY': {
        // markAvailability() upserts unconditionally (one row per (userId, date))
        // and only ever returns { result: 'ok' } — there is no 'not_found' case
        // to handle here, unlike the swap/join actions below.
        const result = await withAuditedTransaction(
          prisma,
          (tx) => markAvailability({ userId: actorId, date: intent.date, type: intent.type, note }, tx),
          (marked) => ({ locationId, actorId, action: 'AVAILABILITY_MARKED', entityType: 'AvailabilityMark', entityId: marked.mark.id, note }),
        );
        return respond(200, { executed: true, result: result.mark }, 'EXECUTED');
      }
      case 'REQUEST_SWAP': {
        const shift = await prisma.shift.findUnique({ where: { id: intent.shiftId }, select: { userId: true, locationId: true, status: true } });
        // Drafts are invisible to staff (lib/shiftVisibility.ts) — same 404 as the REST route.
        const hiddenDraft = shift?.status !== 'PUBLISHED' && !canSeeDraftShifts(req.user, locationId);
        if (!shift || hiddenDraft || shift.userId !== actorId || shift.locationId !== locationId) {
          const msg = 'That shift could not be found among your own upcoming shifts.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        // The proposed cover must be a real, active staff member at the SAME
        // location — otherwise this either silently creates a swap request
        // naming an out-of-location (or nonexistent) "cover", or blows up as
        // a bare Prisma FK-violation 500. Mirrors the equivalent validation
        // in the REST route (server/src/routes/swapRequests.ts).
        const target = await prisma.user.findFirst({
          where: { id: intent.targetUserId, locationId, isActive: true },
          select: { id: true },
        });
        if (!target) {
          const msg = 'That staff member could not be found at your location.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const created = await withAuditedTransaction(
          prisma,
          (tx) => createSwapRequest({ shiftId: intent.shiftId, requestedById: actorId, targetUserId: intent.targetUserId, reason: intent.reason ?? null }, tx),
          (request) => ({ locationId, actorId, shiftId: intent.shiftId, action: 'SWAP_REQUESTED', entityType: 'ShiftSwapRequest', entityId: request.id, note }),
        );
        // Same notification path as the REST route (routes/swapRequests.ts's
        // POST) — never inside the transaction above.
        void notifySwapRequested(created, locationId);
        return respond(201, { executed: true, result: created }, 'EXECUTED');
      }
      case 'APPROVE_SWAP':
      case 'DECLINE_SWAP': {
        // The referenced ShiftSwapRequest must belong to the caller's own
        // location — otherwise a manager at Location A could approve/decline
        // (and, on approval, reassign a shift for) a request that belongs to
        // Location B entirely. REQUEST_SWAP already gets this right for
        // shifts (above); this is the same treatment for the decide path.
        const sr = await prisma.shiftSwapRequest.findUnique({
          where: { id: intent.swapRequestId },
          select: { status: true, shift: { select: { locationId: true } } },
        });
        if (!sr || sr.shift.locationId !== locationId) {
          const msg = 'That swap request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        // decideSwapRequest's 'conflict' result means specifically "a DIFFERENT
        // request already reassigned this shift" — it does NOT catch "this
        // exact request was already approved or declined", so without this
        // guard voice could flip an already-DECLINED request to APPROVED.
        // Mirrors the sibling join path's `already_reviewed` handling below.
        if (sr.status !== 'PENDING') {
          const msg = `That swap request was already ${sr.status.toLowerCase()}.`;
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }

        const decision = intent.intent === 'APPROVE_SWAP' ? 'approved' : 'declined';
        const result = await decideSwapRequest({ id: intent.swapRequestId, decision, reviewedById: actorId });
        if (result.result === 'not_found') {
          const msg = 'That swap request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        // 'conflict' is NOT "already decided" (the PENDING guard above covers
        // that) — isRequestLocked() only ever fires on a still-PENDING request
        // whose shift a DIFFERENT approved request already reassigned.
        if (result.result === 'target_on_leave') {
          return respond(409, { error: result.message }, 'REJECTED_VALIDATION', result.message);
        }
        if (result.result === 'conflict') {
          const msg = 'That shift was already reassigned by another swap request.';
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        // decideSwapRequest already writes its own AuditLog row (SWAP_APPROVED/
        // SWAP_DECLINED) inside its transaction — append the voice transcript by
        // writing a SECOND, linked row rather than mutating the first, keeping
        // the shared action function's own audit write untouched. This row
        // carries the entity's own shiftId (from result.request, which we
        // already have in hand) and its own locationId (from the `sr` lookup
        // above) rather than null/the caller's locationId, matching how
        // REQUEST_SWAP's voice row already does it.
        await writeAuditLog(prisma, {
          locationId: sr.shift.locationId,
          actorId,
          shiftId: result.request.shiftId,
          action: intent.intent === 'APPROVE_SWAP' ? 'SWAP_APPROVED' : 'SWAP_DECLINED',
          entityType: 'ShiftSwapRequest',
          entityId: intent.swapRequestId,
          note,
        });
        // Same notification path as the REST route (routes/swapRequests.ts's
        // PATCH) — never inside the audit write above.
        void notifySwapDecided(result.request, decision);
        return respond(200, { executed: true, result: result.request }, 'EXECUTED');
      }
      case 'APPROVE_JOIN':
      case 'DECLINE_JOIN': {
        // Same location-scoping treatment as APPROVE_SWAP/DECLINE_SWAP above,
        // against JoinRequest.locationId directly.
        const jr = await prisma.joinRequest.findUnique({ where: { id: intent.joinRequestId }, select: { locationId: true } });
        if (!jr || jr.locationId !== locationId) {
          const msg = 'That join request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }

        const decision = intent.intent === 'APPROVE_JOIN' ? 'approve' : 'decline';
        const result = await decideJoinRequest({ requestId: intent.joinRequestId, decision, reviewedById: actorId });
        if (result.result === 'not_found') {
          const msg = 'That join request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        if (result.result === 'already_reviewed') {
          const msg = 'That join request was already reviewed.';
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        await writeAuditLog(prisma, {
          locationId: jr.locationId,
          actorId,
          action: intent.intent === 'APPROVE_JOIN' ? 'JOIN_APPROVED' : 'JOIN_DECLINED',
          entityType: 'JoinRequest',
          entityId: intent.joinRequestId,
          note,
        });
        // Return the entity itself, like every sibling branch does
        // (result.mark, result.request, created) — not the whole
        // action-function envelope, which nested confusingly as
        // {"result":{"result":"ok",...}}.
        return respond(200, { executed: true, result: { status: result.status, userId: result.userId } }, 'EXECUTED');
      }
      case 'CREATE_SHIFT': {
        const role = await prisma.role.findUnique({ where: { id: intent.roleId } });
        if (!role || role.locationId !== locationId) {
          const msg = `Role "${intent.roleId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        if (intent.userId) {
          const staff = await prisma.user.findUnique({ where: { id: intent.userId } });
          if (!staff || staff.locationId !== locationId) {
            const msg = `Staff member "${intent.userId}" not found.`;
            return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
          }
          const leave = await findBlockingLeave(intent.userId, intent.date);
          if (leave) {
            const msg = blockedByLeaveMessage(leave, staff.fullName);
            return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
          }
        }
        const timezone = await venueTimezoneFor(locationId);
        const overnight = intent.end <= intent.start;
        const startTime = combineDateAndTime(intent.date, intent.start, timezone);
        const endTime = combineDateAndTime(intent.date, intent.end, timezone, overnight);

        const created = await withAuditedTransaction(
          prisma,
          (tx) =>
            createShift(
              {
                locationId,
                roleId: intent.roleId,
                userId: intent.userId,
                createdById: actorId,
                date: new Date(`${intent.date}T00:00:00.000Z`),
                startTime,
                endTime,
                breakMinutes: 0,
                sidework: [],
                status: 'DRAFT',
              } as unknown as Parameters<typeof createShift>[0],
              tx,
            ),
          (shift) => ({ locationId, actorId, shiftId: shift.id, action: 'SHIFT_CREATED', entityType: 'Shift', entityId: shift.id, note }),
        );
        return respond(201, { executed: true, result: created }, 'EXECUTED');
      }
      case 'EDIT_SHIFT': {
        const existing = await prisma.shift.findUnique({ where: { id: intent.shiftId } });
        if (!existing || existing.locationId !== locationId) {
          const msg = `Shift "${intent.shiftId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const timezone = await venueTimezoneFor(locationId);
        const data: Record<string, unknown> = {};
        if (intent.roleId !== undefined) {
          const role = await prisma.role.findUnique({ where: { id: intent.roleId } });
          if (!role || role.locationId !== locationId) {
            const msg = `Role "${intent.roleId}" not found.`;
            return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
          }
          data.roleId = intent.roleId;
        }
        if (intent.userId !== undefined) {
          if (intent.userId) {
            const staff = await prisma.user.findUnique({ where: { id: intent.userId } });
            if (!staff || staff.locationId !== locationId) {
              const msg = `Staff member "${intent.userId}" not found.`;
              return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
            }
            data.userId = intent.userId;
          } else {
            data.userId = null;
          }
        }
        const nextDate = intent.date ?? existing.date.toISOString().slice(0, 10);
        const nextStart = intent.start ?? formatVenueTime(existing.startTime, timezone);
        const nextEnd = intent.end ?? formatVenueTime(existing.endTime, timezone);
        if (intent.date !== undefined || intent.start !== undefined || intent.end !== undefined) {
          const overnight = nextEnd <= nextStart;
          data.date = new Date(`${nextDate}T00:00:00.000Z`);
          data.startTime = combineDateAndTime(nextDate, nextStart, timezone);
          data.endTime = combineDateAndTime(nextDate, nextEnd, timezone, overnight);
        }
        const nextUserId = intent.userId !== undefined ? intent.userId : existing.userId;
        if (nextUserId && (intent.userId !== undefined || intent.date !== undefined)) {
          const leave = await findBlockingLeave(nextUserId, nextDate);
          if (leave) {
            const msg = blockedByLeaveMessage(leave);
            return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
          }
        }

        // Same mutator as REST PATCH: audit row + write + staff notification when the shift was PUBLISHED.
        const updated = await editShift({ id: intent.shiftId, data: data as Parameters<typeof editShift>[0]['data'], audit: { locationId, actorId, note } });
        return respond(200, { executed: true, result: updated }, 'EXECUTED');
      }
      case 'ASSIGN_SECTION': {
        const section = await prisma.floorSection.findUnique({ where: { id: intent.sectionId } });
        if (!section || section.locationId !== locationId) {
          const msg = `Section "${intent.sectionId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const staff = await prisma.user.findUnique({ where: { id: intent.staffId } });
        if (!staff || staff.locationId !== locationId) {
          const msg = `Staff member "${intent.staffId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const shiftDate = new Date(`${intent.shiftDate}T00:00:00.000Z`);

        const assignment = await withAuditedTransaction(
          prisma,
          (tx) =>
            upsertSectionAssignment(
              {
                sectionId: intent.sectionId,
                staffId: intent.staffId,
                shiftDate,
                period: intent.period,
                dutyLabel: intent.dutyLabel,
                createdById: actorId,
                touchDutyLabel: intent.dutyLabel !== null,
              },
              tx,
            ),
          (upserted) => ({
            locationId,
            actorId,
            shiftId: null,
            action: 'SHIFT_ASSIGNED',
            entityType: 'SectionAssignment',
            entityId: upserted.id,
            note,
          }),
        );
        return respond(201, { executed: true, result: assignment }, 'EXECUTED');
      }
      case 'PUBLISH_ROTA': {
        const weekStart = new Date(`${intent.weekStart}T00:00:00.000Z`);
        const result = await publishRota({ locationId, weekStart, publishedById: actorId });
        if (result.result === 'not_found') {
          return respond(404, { error: result.message }, 'REJECTED_VALIDATION', result.message);
        }
        if (result.result === 'empty') {
          return respond(400, { error: result.message }, 'REJECTED_VALIDATION', result.message);
        }
        // Same notification path as the REST route (routes/shifts.ts's
        // publish endpoint) — never inside publishRota's own transaction.
        void notifySchedulePublished(result.affectedUserIds, intent.weekStart);
        return respond(
          200,
          { executed: true, result: { publishedAt: result.publishedAt.toISOString(), notifiedCount: result.notifiedCount } },
          'EXECUTED',
        );
      }
      case 'APPLY_ROTA_TEMPLATE': {
        // intent.templateId is required non-empty by validateIntentShape
        // above — a null templateId here means /parse-intent's fuzzy-match
        // refinement never confidently resolved one (see parseIntent.ts's
        // refineApplyRotaTemplateResponse), so a hand-crafted request that
        // skips that refinement is rejected the same way, not silently
        // allowed through with no template.
        //
        // Re-validated fresh here, same as every other case above (CREATE_
        // SHIFT's role/staff, EDIT_SHIFT's shift, ASSIGN_SECTION's section) —
        // /parse-intent's own template candidate list is scoped to the
        // caller's locationId, but that's enforcement by the model, not a
        // structural guarantee (see this route's own doc comment above).
        // Without this check a hand-crafted request naming another venue's
        // templateId would have applyRotaTemplate create real Shift rows in
        // that other venue, under this caller's own actorId.
        const templateForOwnershipCheck = await prisma.rotaTemplate.findUnique({ where: { id: intent.templateId as string } });
        if (!templateForOwnershipCheck || templateForOwnershipCheck.locationId !== locationId) {
          const msg = `Template "${intent.templateId}" not found.`;
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const weekStart = new Date(`${intent.weekStart}T00:00:00.000Z`);
        const result = await applyRotaTemplate({ templateId: intent.templateId as string, weekStart, createdById: actorId, actorId });
        if (result.result !== 'ok') {
          return respond(result.result === 'blocked_by_leave' ? 409 : 404, { error: result.message }, 'REJECTED_VALIDATION', result.message);
        }
        return respond(201, { executed: true, result: { createdCount: result.createdCount, templateName: result.templateName } }, 'EXECUTED');
      }
      case 'POST_ANNOUNCEMENT': {
        const result = await createAnnouncement({ locationId, authorId: actorId, body: intent.content });
        if (result.result !== 'ok') {
          const status = result.result === 'rate_limited' ? 429 : result.result === 'too_long' ? 400 : 404;
          return respond(status, { error: result.message }, 'REJECTED_VALIDATION', result.message);
        }
        return respond(201, { executed: true, result: result.announcement }, 'EXECUTED');
      }
      case 'POST_SHOUTOUT': {
        // Location-scoped existence check on the resolved targetUserId,
        // re-validated fresh here before calling createShoutout — same
        // defense-in-depth pattern REQUEST_SWAP's targetUserId check and
        // Slice 3's APPLY_ROTA_TEMPLATE templateId check already use in this
        // same file, built in from the start rather than retrofitted (that
        // review finding is exactly why this check exists here instead of
        // being assumed safe because createShoutout below also checks it).
        // /parse-intent's own staffDirectory candidate list is scoped to the
        // caller's locationId, but that's enforcement by the model, not a
        // structural guarantee — a hand-crafted request naming a staff
        // member from another venue must still be rejected here, not just
        // inside createShoutout (which duplicates this check for its OWN
        // callers, e.g. the REST route, not as a substitute for this one).
        const target = await prisma.user.findFirst({ where: { id: intent.targetUserId, locationId, isActive: true }, select: { id: true } });
        if (!target) {
          const msg = 'That staff member could not be found at your location.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        const result = await createShoutout({ locationId, employeeId: intent.targetUserId, authorId: actorId, shiftSnapshot: null, note: intent.content });
        if (result.result !== 'ok') {
          const status = result.result === 'rate_limited' ? 429 : result.result === 'too_long' ? 400 : 404;
          return respond(status, { error: result.message }, 'REJECTED_VALIDATION', result.message);
        }
        return respond(201, { executed: true, result: result.shoutout }, 'EXECUTED');
      }
      case 'UNRECOGNIZED': {
        const msg = 'This command was not recognized — nothing was executed.';
        return respond(400, { error: msg }, 'REJECTED_VALIDATION', 'unrecognized');
      }
      default: {
        const msg = 'Unknown intent.';
        return respond(400, { error: msg }, 'REJECTED_VALIDATION', msg);
      }
    }
  } catch (err) {
    console.error('[voice.execute] failed', err);
    return respond(500, { error: 'Unexpected error while executing the voice command.' }, 'ERROR');
  }
});

/**
 * GET /api/voice/interactions — read model for VoiceInteractionLog, scoped
 * to the caller's own location. Manager-only: this is an audit trail over
 * everyone's voice commands at the venue, not a per-user history. Cursor-
 * paginated newest-first since the table is write-only/unbounded (every
 * /parse-intent call logs a row regardless of outcome).
 */
voiceRouter.get('/interactions', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const rows = await prisma.voiceInteractionLog.findMany({
      where: { locationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { actor: { select: { id: true, fullName: true } } },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return res.status(200).json({
      interactions: page.map((row) => ({
        id: row.id,
        actor: row.actor,
        transcript: row.transcript,
        resolvedIntent: row.resolvedIntent,
        confidence: row.confidence,
        hasAdditionalRequest: row.hasAdditionalRequest,
        outcome: row.outcome,
        declineReason: row.declineReason,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  } catch (err) {
    console.error('[voice.interactions] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading voice interactions.' });
  }
});
