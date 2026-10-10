import { isIsoDate, isMondayIso, WEEK_START_NOT_MONDAY_ERROR } from '../lib/venueWeek.js';
import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager } from '../middleware/requireSession.js';
import { transcribeRateLimiter, parseIntentRateLimiter, voiceExecuteRateLimiter } from '../middleware/rateLimit.js';
import { transcribeAudio, VoiceTranscriptionError } from '../voice/transcribe.js';
import { venueSpellingHint } from '../voice/context.js';
import { parseVoiceIntent, VoiceIntentError } from '../voice/parseIntent.js';
import type { AiBudgetExceededError } from '../lib/aiBudget.js';
import { logParsedInteraction, shouldPromptForAdditionalRequest } from '../voice/interactionLog.js';
import { allowedIntentsFor, MANAGER_INTENTS, type ParsedIntent } from '../voice/intentSchema.js';
import { createSwapRequest, decideSwapRequest, notifySwapRequested, notifySwapDecided } from '../lib/actions/swapActions.js';
import { SwapWindowClosedError } from '../lib/swapRequestPolicy.js';
import { decideJoinRequest, JOIN_LINK_CHOICE_MESSAGE, JOIN_PHONE_TAKEN_ERROR } from '../lib/actions/joinActions.js';
import { markAvailability } from '../lib/actions/availabilityActions.js';
import { writeAuditLog, withAuditedTransaction } from '../lib/auditLog.js';
import { SHIFT_INCLUDE } from '../lib/actions/shiftActions.js';
import { findActiveVenueRole, findVenueUser, isPastVenueDay, isRealDate } from '../lib/shiftRules.js';
import { isClockTime } from '../voice/times.js';
import { upsertSectionAssignment } from '../lib/actions/sectionActions.js';
import { applyRotaTemplate } from '../lib/actions/rotaActions.js';
import { publishWeek, shiftRangesOf } from '../lib/actions/weekActions.js';
import { createTimeOffRequest } from '../lib/actions/timeOffActions.js';
import { createAnnouncement, createShoutout } from '../lib/actions/communicationActions.js';
import { updateInteractionOutcome } from '../voice/interactionLog.js';
import { venueTimezoneFor } from '../lib/venueTime.js';
import { applyVoicePatches, refusalReply, type VoicePatchOutcome, type VoiceWeekPatch } from '../voice/weekWrites.js';
import { mondayOf, validateRanges, type TimeRange } from '../../../shared/rotaWeek.js';

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
/** Longest command /parse-intent reads; the sheet's edit box allows 300 characters. */
const MAX_TRANSCRIPT_CHARS = 500;
/** Time off is asked for at most this many days at a time (the voice tool's cap). */
const MAX_TIME_OFF_DAYS = 14;
const daysInRange = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

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
/** The clip had no clear speech; nothing was sent on to be understood. */
export const VOICE_NO_SPEECH = "I didn't hear a command. Hold the phone a little closer and try again.";
/** A retired/misspelled model is not fixed by retrying, so say so (and point at the buttons). */
const VOICE_MODEL_UNAVAILABLE = "Voice commands are switched off on this server until its AI model setting is updated. Use the app's buttons meanwhile.";
/** No AI backend on this server at all (no Vertex project, no key). */
export const VOICE_NOT_CONFIGURED = "Voice commands aren't set up on this server yet. Use the app's buttons meanwhile.";
/** The in-app AI spend cap (lib/aiBudget.ts) refused the call before anything was sent. */
export const VOICE_PAUSED_MONTH = "Voice commands are paused for the rest of this month (AI spending limit reached). Use the app's buttons meanwhile.";
export const VOICE_PAUSED_TODAY = "Voice commands have reached today's limit and are back tomorrow. Use the app's buttons meanwhile.";
export const VOICE_PAUSED_USER = "You've used today's voice commands; they're back tomorrow. Use the app's buttons meanwhile.";
export const VOICE_PAUSED_VENUE = "Your venue has used today's voice commands; they're back tomorrow. Use the app's buttons meanwhile.";

/** 503 body for a refusal by the spend cap; an unreachable ledger is an outage, not a limit. */
function pausedBody(limit: AiBudgetExceededError['limit'] | undefined): { error: string; errorCode: string } {
  if (limit === 'daily_calls') return { error: VOICE_PAUSED_TODAY, errorCode: 'ai_paused' };
  if (limit === 'user_daily') return { error: VOICE_PAUSED_USER, errorCode: 'ai_paused' };
  if (limit === 'venue_daily') return { error: VOICE_PAUSED_VENUE, errorCode: 'ai_paused' };
  if (limit === 'monthly_budget') return { error: VOICE_PAUSED_MONTH, errorCode: 'ai_paused' };
  return { error: VOICE_UNAVAILABLE, errorCode: 'voice_unavailable' };
}

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
    case 'REQUEST_TIME_OFF': {
      if (!isRealDate(intent.startDate) || !isRealDate(intent.endDate)) return 'startDate/endDate must be real calendar dates (YYYY-MM-DD).';
      if (intent.endDate < intent.startDate) return 'endDate must not be before startDate.';
      if (daysInRange(intent.startDate, intent.endDate) > MAX_TIME_OFF_DAYS) return `Time off can be asked for up to ${MAX_TIME_OFF_DAYS} days at a time.`;
      if (intent.reason !== null && intent.reason !== undefined && typeof intent.reason !== 'string') return 'reason must be a string or null.';
      return null;
    }
    case 'CREATE_SHIFT': {
      if (!isNonEmptyString(intent.roleId)) return 'roleId is required.';
      if (!DATE_RE.test(intent.date)) return 'date must be YYYY-MM-DD.';
      if (!isRealDate(intent.date)) return 'date must be a real calendar date (YYYY-MM-DD).';
      if (!isClockTime(intent.start) || !isClockTime(intent.end)) return 'start/end must be HH:MM.';
      if (intent.userId !== null && intent.userId !== undefined && !isNonEmptyString(intent.userId)) return 'userId must be an id or null.';
      if (intent.second !== undefined && (!intent.second || !isClockTime(intent.second.start) || !isClockTime(intent.second.end))) return 'second.start/second.end must be HH:MM.';
      if (intent.shiftTypeId !== undefined && !isNonEmptyString(intent.shiftTypeId)) return 'shiftTypeId must be an id.';
      if (intent.overridePendingRequest !== undefined && typeof intent.overridePendingRequest !== 'boolean') return 'overridePendingRequest must be true or false.';
      return null;
    }
    case 'EDIT_SHIFT': {
      if (!isNonEmptyString(intent.shiftId)) return 'shiftId is required.';
      if (intent.date !== undefined && !isRealDate(intent.date)) return 'date must be a real calendar date (YYYY-MM-DD).';
      if (intent.start !== undefined && !isClockTime(intent.start)) return 'start must be HH:MM.';
      if (intent.end !== undefined && !isClockTime(intent.end)) return 'end must be HH:MM.';
      if (intent.second !== undefined && intent.second !== null && (!isClockTime(intent.second.start) || !isClockTime(intent.second.end))) return 'second.start/second.end must be HH:MM.';
      if (intent.shiftTypeId !== undefined && !isNonEmptyString(intent.shiftTypeId)) return 'shiftTypeId must be an id.';
      if (intent.userId !== undefined && intent.userId !== null && !isNonEmptyString(intent.userId)) return 'userId must be an id or null.';
      if (intent.overridePendingRequest !== undefined && typeof intent.overridePendingRequest !== 'boolean') return 'overridePendingRequest must be true or false.';
      return null;
    }
    case 'CANCEL_SHIFT':
      if (!isNonEmptyString(intent.shiftId)) return 'shiftId is required.';
      return null;
    case 'ASSIGN_SECTION': {
      if (!isNonEmptyString(intent.sectionId)) return 'sectionId is required.';
      if (!isNonEmptyString(intent.staffId)) return 'staffId is required.';
      if (!isRealDate(intent.shiftDate)) return 'shiftDate must be a real calendar date (YYYY-MM-DD).';
      if (intent.period !== 'AM' && intent.period !== 'PM') return 'period must be "AM" or "PM".';
      return null;
    }
    case 'PUBLISH_ROTA': {
      if (!DATE_RE.test(intent.weekStart)) return 'weekStart must be YYYY-MM-DD.';
      if (!isIsoDate(intent.weekStart)) return 'weekStart must be a real calendar date (YYYY-MM-DD).';
      // The model is told weekStart is the Monday; never trust its arithmetic.
      if (!isMondayIso(intent.weekStart)) return WEEK_START_NOT_MONDAY_ERROR;
      // What the confirm sheet showed: /parse-intent's publish preview, bound by version and fingerprint.
      if (!Number.isInteger(intent.version) || !isNonEmptyString(intent.fingerprint)) return 'Ask again to see what this publish will change, then confirm.';
      return null;
    }
    case 'APPLY_ROTA_TEMPLATE': {
      if (!isNonEmptyString(intent.templateId)) return 'templateId is required.';
      if (!DATE_RE.test(intent.weekStart)) return 'weekStart must be YYYY-MM-DD.';
      if (!isIsoDate(intent.weekStart)) return 'weekStart must be a real calendar date (YYYY-MM-DD).';
      if (!isMondayIso(intent.weekStart)) return WEEK_START_NOT_MONDAY_ERROR;
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
      // The same bounded hint intent parsing gets (voice/context.ts): active staff names and
      // section names only, capped, de-duplicated, contact-looking text dropped.
      vocabulary = await venueSpellingHint(req.user!.locationId);
    } catch (vocabErr) {
      console.error('[voice.transcribe] failed to build vocabulary hint, transcribing without it', vocabErr);
      vocabulary = undefined;
    }

    const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype, vocabulary, req.user!.locationId, req.user!.id);
    return res.status(200).json({ transcript });
  } catch (err) {
    if (err instanceof VoiceTranscriptionError && err.kind === 'format_rejected') {
      // Gemini refused the audio format itself — a bug in what this phone
      // records vs what we send, not an outage. Say so, so it is never
      // mistaken for quota, and keep the mimetype in the log line.
      console.error(`[voice.transcribe] format rejected (mime=${req.file?.mimetype})`, err);
      return res.status(415).json({
        error: `Your phone's recording format (${req.file?.mimetype ?? 'unknown'}) wasn't accepted by the transcription service. This is a bug on our side rather than an outage — please tell us your phone model.`,
        errorCode: 'voice_format_rejected',
      });
    }
    if (err instanceof VoiceTranscriptionError && err.kind === 'paused') {
      return res.status(503).json(pausedBody(err.limit));
    }
    if (err instanceof VoiceTranscriptionError && err.kind === 'not_configured') {
      return res.status(503).json({ error: VOICE_NOT_CONFIGURED, errorCode: 'voice_not_configured' });
    }
    if (err instanceof VoiceTranscriptionError && err.kind === 'no_speech') {
      return res.status(422).json({ error: VOICE_NO_SPEECH, errorCode: 'voice_no_speech' });
    }
    if (err instanceof VoiceTranscriptionError && err.kind === 'model_unavailable') {
      return res.status(503).json({ error: VOICE_MODEL_UNAVAILABLE, errorCode: 'voice_model_unavailable' });
    }
    if (err instanceof VoiceTranscriptionError) {
      console.error('[voice.transcribe] unavailable', err);
      return res.status(503).json({ error: VOICE_UNAVAILABLE, errorCode: 'voice_unavailable' });
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
    // A recording is at most 10 seconds, but the confirm sheet also lets people type a correction
    // ("Try again"): keep that to a spoken-command length before anything is sent to the model.
    if (transcript.length > MAX_TRANSCRIPT_CHARS) return res.status(400).json({ error: 'That command is too long. Keep it to a sentence or two.' });

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
    if (err instanceof VoiceIntentError && err.paused) {
      return res.status(503).json(pausedBody(err.limit));
    }
    if (err instanceof VoiceIntentError && err.notConfigured) {
      return res.status(503).json({ error: VOICE_NOT_CONFIGURED, errorCode: 'voice_not_configured' });
    }
    if (err instanceof VoiceIntentError && err.modelUnavailable) {
      return res.status(503).json({ error: VOICE_MODEL_UNAVAILABLE, errorCode: 'voice_model_unavailable' });
    }
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
voiceRouter.post('/execute', requireSession, voiceExecuteRateLimiter, async (req, res) => {
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
      // What the caller confirmed: another reading than the logged one only after a "which did you mean?" choice.
      const confirmed = typeof intent?.intent === 'string' && intent.intent !== 'UNRECOGNIZED' && ALL_INTENTS.includes(intent.intent) ? intent.intent : undefined;
      await updateInteractionOutcome(voiceLogId, req.user!.id, outcome, declineReason, confirmed).catch((err) =>
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

    // One command runs once: a Confirm retried after a slow or dropped first try (same voice log)
    // must not create a second shift. The log row is claimed in one conditional update; a row
    // already claimed is answered 409 without touching anything (and without `respond`, which
    // would overwrite the first try's outcome). A refused or failed run records its own outcome,
    // which releases the claim, so the command can be confirmed again.
    if (voiceLogId) {
      const claimed = await prisma.voiceInteractionLog.updateMany({ where: { id: voiceLogId, actorId: req.user!.id, outcome: { not: 'EXECUTED' } }, data: { outcome: 'EXECUTED' } });
      if (claimed.count === 0 && (await prisma.voiceInteractionLog.count({ where: { id: voiceLogId, actorId: req.user!.id } }))) {
        return res.status(409).json({ error: 'That command has already been done.', errorCode: 'voice_already_executed' });
      }
    }

    const note = `[voice] "${transcript}"`;
    const actorId = req.user!.id;
    const locationId = req.user!.locationId;
    const timezone = await venueTimezoneFor(locationId);
    /** Every change is re-checked here, whatever /parse-intent offered: a hand-built body skips it. */
    const refuse = (status: number, msg: string) => respond(status, { error: msg }, 'REJECTED_VALIDATION', msg);
    /** A week-patch refusal (or a week that kept moving): the voice sheet's wording and status; nothing was changed. */
    const refusePatch = (outcome: Exclude<VoicePatchOutcome, { result: 'ok' }>) => {
      const reply = outcome.result === 'refused' ? refusalReply(outcome.refusal, outcome.message) : refusalReply('version_conflict', '');
      const errorCode = outcome.result === 'refused' ? outcome.refusal : 'version_conflict';
      return respond(reply.status, { error: reply.error, errorCode }, 'REJECTED_VALIDATION', reply.error);
    };
    const PAST = 'That day has already passed.';

    switch (intent.intent) {
      case 'REQUEST_TIME_OFF': {
        if (isPastVenueDay(intent.startDate, timezone)) return refuse(400, PAST);
        // A real time-off request (rota v2): the same single writer as POST /api/time-off. It waits for a
        // manager; approving it turns the days into leave through the week patch.
        const reason = typeof intent.reason === 'string' && intent.reason.trim() ? intent.reason.trim() : null;
        const filed = await withAuditedTransaction(
          prisma,
          (tx) => createTimeOffRequest({ userId: actorId, startDate: intent.startDate, endDate: intent.endDate, reason }, tx),
          (r) => (r.result === 'ok' ? { locationId, actorId, action: 'TIME_OFF_REQUESTED', entityType: 'TimeOffRequest', entityId: r.id, note } : null),
        );
        if (filed.result === 'duplicate') return respond(409, { error: filed.message, errorCode: 'time_off_duplicate' }, 'REJECTED_VALIDATION', filed.message);
        if (filed.result === 'invalid') return refuse(400, filed.message);
        return respond(201, { executed: true, result: { request: { id: filed.id, startDate: filed.startDate, endDate: filed.endDate, status: 'pending' } } }, 'EXECUTED');
      }
      case 'MARK_AVAILABILITY': {
        if (isPastVenueDay(intent.date, timezone)) return refuse(400, PAST);
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
        const shift = await prisma.shift.findUnique({ where: { id: intent.shiftId }, select: { userId: true, locationId: true } });
        if (!shift || shift.userId !== actorId || shift.locationId !== locationId) {
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
        let created;
        try {
          created = await withAuditedTransaction(
            prisma,
            (tx) => createSwapRequest({ shiftId: intent.shiftId, requestedById: actorId, targetUserId: intent.targetUserId, reason: intent.reason ?? null }, tx),
            (request) => ({ locationId, actorId, shiftId: intent.shiftId, action: 'SWAP_REQUESTED', entityType: 'ShiftSwapRequest', entityId: request.id, note }),
          );
        } catch (err) {
          // The week's request window has closed (Wednesday 17:00, venue time) — same answer as the REST route.
          if (err instanceof SwapWindowClosedError) return respond(409, { error: err.message, errorCode: 'swap_window_closed' }, 'REJECTED_VALIDATION', err.message);
          throw err;
        }
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
        if (result.result === 'conflict') {
          const msg = 'That shift was already reassigned by another swap request.';
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        // Decided by someone else between the PENDING check above and this call.
        if (result.result === 'already_decided') {
          const msg = `That swap request was already ${result.status.toLowerCase()}.`;
          return respond(409, { error: msg }, 'REJECTED_VALIDATION', msg);
        }
        // Rota builder v2 person-day rules: the cover cannot take the shift as the week stands.
        if (result.result === 'target_on_leave' || result.result === 'target_has_shift') {
          const msg =
            result.result === 'target_on_leave'
              ? 'The covering staff member is on leave that day, so this request cannot be approved.'
              : 'The covering staff member already has a shift that day, so this request cannot be approved.';
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
        if (result.result === 'phone_taken') {
          return respond(409, { error: JOIN_PHONE_TAKEN_ERROR }, 'REJECTED_VALIDATION', JOIN_PHONE_TAKEN_ERROR);
        }
        // Who they are among the roster's imported staff is the manager's call, made on screen.
        if (result.result === 'link_choice_required' || result.result === 'link_target_invalid') {
          const msg = `${JOIN_LINK_CHOICE_MESSAGE} Approve this one in People → Pending Approvals.`;
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
        // Friendly answers for what the week patch would also refuse, then the patch itself (source
        // 'voice'): one shift, one or two ranges (a split is ONE shift with two ranges), the venue
        // shift type when one was named.
        if (!(await findActiveVenueRole(intent.roleId, locationId))) return refuse(404, `Role "${intent.roleId}" not found or no longer active.`);
        if (intent.userId && !(await findVenueUser(intent.userId, locationId, { activeOnly: true }))) return refuse(404, `Staff member "${intent.userId}" not found.`);
        if (isPastVenueDay(intent.date, timezone)) return refuse(400, PAST);
        const ranges: TimeRange[] = [{ start: intent.start, end: intent.end }, ...(intent.second ? [{ start: intent.second.start, end: intent.second.end }] : [])];
        if (!validateRanges(ranges)) return refuse(400, intent.second ? 'The two parts of a split shift overlap.' : 'A shift must start and end at different times.');
        const weekStart = mondayOf(intent.date);
        const outcome = await applyVoicePatches({
          locationId,
          actorId,
          transcript,
          patches: [{ weekStart, ops: [{ op: 'create', userId: intent.userId ?? null, roleId: intent.roleId, date: intent.date, ranges, ...(intent.shiftTypeId ? { shiftTypeId: intent.shiftTypeId } : {}) }] }],
          overridePendingRequests: intent.overridePendingRequest === true,
        });
        if (outcome.result !== 'ok') return refusePatch(outcome);
        const week = outcome.weeks[0]!;
        const shift = await prisma.shift.findUnique({ where: { id: week.results[0]!.shiftId! }, include: SHIFT_INCLUDE });
        return respond(201, { executed: true, result: { ...shift, version: week.version, declinedRequestIds: week.declinedRequestIds }, roster: { locationId, weekStart, version: week.version } }, 'EXECUTED');
      }
      case 'EDIT_SHIFT': {
        const existing = await prisma.shift.findUnique({ where: { id: intent.shiftId } });
        if (!existing || existing.locationId !== locationId || existing.status === 'CANCELLED') return refuse(404, `Shift "${intent.shiftId}" not found.`);
        const currentDate = existing.date.toISOString().slice(0, 10);
        if (isPastVenueDay(currentDate, timezone) || (intent.date !== undefined && isPastVenueDay(intent.date, timezone))) return refuse(400, PAST);
        // A removed role stays on old shifts, but nothing is moved onto it.
        if (intent.roleId !== undefined && !(await findActiveVenueRole(intent.roleId, locationId))) return refuse(404, `Role "${intent.roleId}" not found or no longer active.`);
        if (intent.userId && !(await findVenueUser(intent.userId, locationId, { activeOnly: true }))) return refuse(404, `Staff member "${intent.userId}" not found.`);

        // New times, from the shift's own ranges: a split keeps its break unless the command
        // reshaped it (a split type, a second part, or `second: null` to make it one range again).
        const current = shiftRangesOf(existing, timezone).ranges;
        let ranges: TimeRange[] | undefined;
        if (intent.start !== undefined || intent.end !== undefined || intent.second !== undefined || intent.shiftTypeId !== undefined) {
          const first = current[0]!;
          const last = current[current.length - 1]!;
          if (intent.second !== undefined) ranges = [{ start: intent.start ?? first.start, end: intent.end ?? first.end }, ...(intent.second ? [{ start: intent.second.start, end: intent.second.end }] : [])];
          else if (current.length === 2) ranges = [{ start: intent.start ?? first.start, end: first.end }, { start: last.start, end: intent.end ?? last.end }];
          else ranges = [{ start: intent.start ?? first.start, end: intent.end ?? first.end }];
          const split = ranges.length === 2;
          if (!validateRanges(ranges)) return refuse(400, split ? 'The two parts of a split shift overlap.' : 'A shift must start and end at different times.');
        }
        // Custom times drop the old type's name; a named type keeps it.
        const timing = ranges ? { ranges, shiftTypeId: intent.shiftTypeId ?? null } : {};
        const date = intent.date ?? currentDate;
        const fromWeek = mondayOf(currentDate);
        const toWeek = mondayOf(date);
        let patches: VoiceWeekPatch[];
        if (fromWeek === toWeek) {
          patches = [
            {
              weekStart: fromWeek,
              ops: [
                {
                  op: 'update',
                  shiftId: existing.id,
                  ...(intent.userId !== undefined ? { userId: intent.userId } : {}),
                  ...(intent.roleId !== undefined ? { roleId: intent.roleId } : {}),
                  ...(intent.date !== undefined ? { date: intent.date } : {}),
                  ...timing,
                },
              ],
            },
          ];
        } else {
          // Into another week: created there and removed here in one transaction, so each week's
          // version, rules and publish diff stay its own (a published shift is told as removed).
          const keepType = ranges ? intent.shiftTypeId : (existing.shiftTypeId ?? undefined);
          patches = [
            {
              weekStart: toWeek,
              ops: [
                {
                  op: 'create',
                  userId: intent.userId !== undefined ? intent.userId : existing.userId,
                  roleId: intent.roleId ?? existing.roleId,
                  ...(intent.roleId === undefined ? { departmentId: existing.departmentId } : {}),
                  date,
                  ranges: ranges ?? current,
                  ...(keepType ? { shiftTypeId: keepType } : {}),
                  note: existing.note,
                },
              ],
            },
            { weekStart: fromWeek, ops: [{ op: 'delete', shiftId: existing.id }] },
          ];
        }
        const outcome = await applyVoicePatches({ locationId, actorId, transcript, patches, overridePendingRequests: intent.overridePendingRequest === true });
        if (outcome.result !== 'ok') return refusePatch(outcome);
        const landed = outcome.weeks[0]!;
        const shift = await prisma.shift.findUnique({ where: { id: landed.results[0]!.shiftId! }, include: SHIFT_INCLUDE });
        return respond(
          200,
          { executed: true, result: { ...shift, version: landed.version, declinedRequestIds: landed.declinedRequestIds }, roster: { locationId, weekStart: toWeek, version: landed.version } },
          'EXECUTED',
        );
      }
      case 'CANCEL_SHIFT': {
        // The grid's delete: a draft goes, a published shift is removed at the next publish (and the person told then).
        const existing = await prisma.shift.findUnique({ where: { id: intent.shiftId } });
        if (!existing || existing.locationId !== locationId || existing.status === 'CANCELLED') return refuse(404, `Shift "${intent.shiftId}" not found.`);
        const date = existing.date.toISOString().slice(0, 10);
        if (isPastVenueDay(date, timezone)) return refuse(400, 'That shift has already happened.');
        const weekStart = mondayOf(date);
        const outcome = await applyVoicePatches({ locationId, actorId, transcript, patches: [{ weekStart, ops: [{ op: 'delete', shiftId: existing.id }] }] });
        if (outcome.result !== 'ok') return refusePatch(outcome);
        const version = outcome.weeks[0]!.version;
        return respond(200, { executed: true, result: { id: existing.id, cancelled: true, version }, roster: { locationId, weekStart, version } }, 'EXECUTED');
      }
      case 'ASSIGN_SECTION': {
        const section = await prisma.floorSection.findUnique({ where: { id: intent.sectionId } });
        if (!section || section.locationId !== locationId) return refuse(404, `Section "${intent.sectionId}" not found.`);
        if (!(await findVenueUser(intent.staffId, locationId, { activeOnly: true }))) return refuse(404, `Staff member "${intent.staffId}" not found.`);
        if (isPastVenueDay(intent.shiftDate, timezone)) return refuse(400, PAST);
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
        // Exactly the diff the confirm sheet showed: publishWeek recomputes it and compares the fingerprint.
        const result = await publishWeek({ locationId, weekStart: intent.weekStart, actorId, expectedVersion: intent.version as number, fingerprint: intent.fingerprint as string });
        if (result.result === 'version_conflict' || result.result === 'fingerprint_mismatch') {
          const msg = 'The week changed since you asked. Ask again to see what publishing will change now.';
          return respond(409, { error: msg, errorCode: 'week_changed' }, 'REJECTED_VALIDATION', msg);
        }
        if (result.result === 'empty') return refuse(400, result.message);
        return respond(
          200,
          {
            executed: true,
            result: { publishedAt: result.publishedAt, notifiedCount: result.notifiedCount, noDeviceUserIds: result.noDeviceUserIds, version: result.version },
            roster: { locationId, weekStart: intent.weekStart, version: result.version },
          },
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
        const weekEnd = new Date(Date.parse(`${intent.weekStart}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
        if (isPastVenueDay(weekEnd, timezone)) return refuse(400, 'That week has already passed.');
        const weekStart = new Date(`${intent.weekStart}T00:00:00.000Z`);
        const result = await applyRotaTemplate({ templateId: intent.templateId as string, weekStart, createdById: actorId, actorId });
        // The week patch refused an entry (someone already on that day, on leave…): nothing was applied.
        // `message` names the entry ("Entry 3: …"), which is what the manager needs to fix the template.
        if (result.result === 'refused') {
          const msg = result.refusal === 'version_conflict' ? result.message : `Nothing was applied. ${result.message}`;
          return respond(409, { error: msg, errorCode: `template_${result.refusal}` }, 'REJECTED_VALIDATION', msg);
        }
        if (result.result !== 'ok') {
          return respond(404, { error: result.message }, 'REJECTED_VALIDATION', result.message);
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
