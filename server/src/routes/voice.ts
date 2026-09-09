import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';
import { transcribeRateLimiter, parseIntentRateLimiter } from '../middleware/rateLimit.js';
import { transcribeAudio, VoiceTranscriptionError } from '../voice/transcribe.js';
import { parseVoiceIntent, VoiceIntentError } from '../voice/parseIntent.js';
import { logParsedInteraction } from '../voice/interactionLog.js';
import { allowedIntentsFor, MANAGER_INTENTS, type ParsedIntent } from '../voice/intentSchema.js';
import { createSwapRequest, decideSwapRequest, notifySwapRequested, notifySwapDecided } from '../lib/actions/swapActions.js';
import { decideJoinRequest } from '../lib/actions/joinActions.js';
import { markAvailability } from '../lib/actions/availabilityActions.js';
import { writeAuditLog, withAuditedTransaction } from '../lib/auditLog.js';

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
    const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype);
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
    return res.status(200).json({ transcript, intent: resolution.response, voiceLogId });
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
  try {
    const transcript = String(req.body?.transcript ?? '');
    const intent = req.body?.intent as ParsedIntent | undefined;
    if (!intent || typeof intent.intent !== 'string') {
      return res.status(400).json({ error: 'A parsed intent is required.' });
    }

    // Check membership in the FULL known intent set FIRST, before the
    // role-permission check runs — this is what makes the switch's own
    // `default: … 400 'Unknown intent.'` branch below reachable at all.
    // Without this ordering, a garbage/unknown intent string fell through
    // to the same misleading 403 as a real-but-not-permitted intent
    // ("Your role does not permit the \"DELETE_EVERYTHING\" action.").
    if (!ALL_INTENTS.includes(intent.intent)) {
      return res.status(400).json({ error: `"${intent.intent}" is not a recognized voice command.` });
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
      return res.status(403).json({ error: `Your role does not permit the "${intent.intent}" action.` });
    }

    // Real, permitted intent (or UNRECOGNIZED) — now check its shape is
    // actually usable before any Prisma call is made.
    const shapeError = validateIntentShape(intent);
    if (shapeError) return res.status(400).json({ error: shapeError });

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
        return res.status(200).json({ executed: true, result: result.mark });
      }
      case 'REQUEST_SWAP': {
        const shift = await prisma.shift.findUnique({ where: { id: intent.shiftId }, select: { userId: true, locationId: true } });
        if (!shift || shift.userId !== actorId || shift.locationId !== locationId) {
          return res.status(404).json({ error: 'That shift could not be found among your own upcoming shifts.' });
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
          return res.status(404).json({ error: 'That staff member could not be found at your location.' });
        }
        const created = await withAuditedTransaction(
          prisma,
          (tx) => createSwapRequest({ shiftId: intent.shiftId, requestedById: actorId, targetUserId: intent.targetUserId, reason: intent.reason ?? null }, tx),
          (request) => ({ locationId, actorId, shiftId: intent.shiftId, action: 'SWAP_REQUESTED', entityType: 'ShiftSwapRequest', entityId: request.id, note }),
        );
        // Same notification path as the REST route (routes/swapRequests.ts's
        // POST) — never inside the transaction above.
        void notifySwapRequested(created, locationId);
        return res.status(201).json({ executed: true, result: created });
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
          return res.status(404).json({ error: 'That swap request could not be found.' });
        }
        // decideSwapRequest's 'conflict' result means specifically "a DIFFERENT
        // request already reassigned this shift" — it does NOT catch "this
        // exact request was already approved or declined", so without this
        // guard voice could flip an already-DECLINED request to APPROVED.
        // Mirrors the sibling join path's `already_reviewed` handling below.
        if (sr.status !== 'PENDING') {
          return res.status(409).json({ error: `That swap request was already ${sr.status.toLowerCase()}.` });
        }

        const decision = intent.intent === 'APPROVE_SWAP' ? 'approved' : 'declined';
        const result = await decideSwapRequest({ id: intent.swapRequestId, decision, reviewedById: actorId });
        if (result.result === 'not_found') return res.status(404).json({ error: 'That swap request could not be found.' });
        // 'conflict' is NOT "already decided" (the PENDING guard above covers
        // that) — isRequestLocked() only ever fires on a still-PENDING request
        // whose shift a DIFFERENT approved request already reassigned.
        if (result.result === 'conflict') {
          return res.status(409).json({ error: 'That shift was already reassigned by another swap request.' });
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
        return res.status(200).json({ executed: true, result: result.request });
      }
      case 'APPROVE_JOIN':
      case 'DECLINE_JOIN': {
        // Same location-scoping treatment as APPROVE_SWAP/DECLINE_SWAP above,
        // against JoinRequest.locationId directly.
        const jr = await prisma.joinRequest.findUnique({ where: { id: intent.joinRequestId }, select: { locationId: true } });
        if (!jr || jr.locationId !== locationId) {
          return res.status(404).json({ error: 'That join request could not be found.' });
        }

        const decision = intent.intent === 'APPROVE_JOIN' ? 'approve' : 'decline';
        const result = await decideJoinRequest({ requestId: intent.joinRequestId, decision, reviewedById: actorId });
        if (result.result === 'not_found') return res.status(404).json({ error: 'That join request could not be found.' });
        if (result.result === 'already_reviewed') return res.status(409).json({ error: 'That join request was already reviewed.' });
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
        return res.status(200).json({ executed: true, result: { status: result.status, userId: result.userId } });
      }
      case 'UNRECOGNIZED':
        return res.status(400).json({ error: 'This command was not recognized — nothing was executed.' });
      default:
        return res.status(400).json({ error: 'Unknown intent.' });
    }
  } catch (err) {
    console.error('[voice.execute] failed', err);
    return res.status(500).json({ error: 'Unexpected error while executing the voice command.' });
  }
});
