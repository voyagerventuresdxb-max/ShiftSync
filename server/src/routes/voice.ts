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
import { createShift, updateShift } from '../lib/actions/shiftActions.js';
import { upsertSectionAssignment } from '../lib/actions/sectionActions.js';
import { updateInteractionOutcome } from '../voice/interactionLog.js';
import { combineDateAndTime } from '../parsing/normalize.js';
import { formatVenueTime, venueTimezoneFor } from '../lib/venueTime.js';

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

    const [staff, sections, roles] = await Promise.all([
      prisma.user.findMany({ where: { locationId: req.user!.locationId, isActive: true }, select: { fullName: true } }),
      prisma.floorSection.findMany({ where: { locationId: req.user!.locationId }, select: { label: true } }),
      prisma.role.findMany({ where: { locationId: req.user!.locationId }, select: { name: true } }),
    ]);
    const vocabulary = [
      ...staff.map((s) => s.fullName),
      ...sections.map((s) => s.label),
      ...roles.map((r) => r.name),
      'rota', 'floor', 'section', 'swap', 'cover', 'shift',
    ].join(', ');

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
        const result = await withAuditedTransaction(
          prisma,
          (tx) => markAvailability({ userId: actorId, date: intent.date, type: intent.type, note }, tx),
          (marked) => ({ locationId, actorId, action: 'AVAILABILITY_MARKED', entityType: 'AvailabilityMark', entityId: marked.mark.id, note }),
        );
        return respond(200, { executed: true, result: result.mark }, 'EXECUTED');
      }
      case 'REQUEST_SWAP': {
        const shift = await prisma.shift.findUnique({ where: { id: intent.shiftId }, select: { userId: true, locationId: true } });
        if (!shift || shift.userId !== actorId || shift.locationId !== locationId) {
          const msg = 'That shift could not be found among your own upcoming shifts.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
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
        void notifySwapRequested(created, locationId);
        return respond(201, { executed: true, result: created }, 'EXECUTED');
      }
      case 'APPROVE_SWAP':
      case 'DECLINE_SWAP': {
        const sr = await prisma.shiftSwapRequest.findUnique({
          where: { id: intent.swapRequestId },
          select: { status: true, shift: { select: { locationId: true } } },
        });
        if (!sr || sr.shift.locationId !== locationId) {
          const msg = 'That swap request could not be found.';
          return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
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
        if (result.result === 'conflict') {
          const msg = 'That shift was already reassigned by another swap request.';
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        await writeAuditLog(prisma, {
          locationId: sr.shift.locationId,
          actorId,
          shiftId: result.request.shiftId,
          action: intent.intent === 'APPROVE_SWAP' ? 'SWAP_APPROVED' : 'SWAP_DECLINED',
          entityType: 'ShiftSwapRequest',
          entityId: intent.swapRequestId,
          note,
        });
        void notifySwapDecided(result.request, decision);
        return respond(200, { executed: true, result: result.request }, 'EXECUTED');
      }
      case 'APPROVE_JOIN':
      case 'DECLINE_JOIN': {
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

        const updated = await withAuditedTransaction(
          prisma,
          (tx) => updateShift(intent.shiftId, data as Parameters<typeof updateShift>[1], tx),
          () => ({ locationId, actorId, shiftId: intent.shiftId, action: 'SHIFT_UPDATED', entityType: 'Shift', entityId: intent.shiftId, note }),
        );
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
