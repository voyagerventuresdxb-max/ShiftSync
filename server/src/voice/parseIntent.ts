import { GoogleGenAI, ApiError, ThinkingLevel } from '@google/genai';
import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { allowedIntentsFor, intentSchemaFor, type ChoosableIntent, type ParsedIntent } from './intentSchema.js';
import { combineDateAndTime } from '../parsing/normalize.js';
import { VOICE_ROLE_REFUSAL } from '../../../shared/voiceIntents.js';
import { buildSystemPrompt, type PromptContext } from './prompts.js';
import { formatVenueTime, venueToday, venueTimezoneFor } from '../lib/venueTime.js';
import { reportIfModelUnavailable, voiceClientOptions, voiceModel } from './model.js';
import { getRotaPublishPreview } from '../lib/actions/rotaActions.js';
import { bestMatch } from '../lib/textSimilarity.js';
import { AiBudgetExceededError, MAX_OUTPUT_TOKENS, textInputEstimate, withAiBudget } from '../lib/aiBudget.js';
import { billedOutputTokens } from '../parsing/visionProvider.js';

export class VoiceIntentError extends Error {
  /** The underlying error (e.g. a Gemini ApiError) that caused this, if any. */
  cause?: unknown;
  /** True when Gemini answered 404 for the configured model (retired/misspelled): an operator fix, not a retry. */
  modelUnavailable: boolean;
  /** True when the in-app AI spend cap refused the call (nothing was sent); `limit` says which. */
  paused = false;
  limit?: AiBudgetExceededError['limit'];
  /** True when no AI backend is set on this server (no Vertex project, no key). */
  notConfigured = false;

  constructor(message: string, cause?: unknown, modelUnavailable = false) {
    super(message);
    this.name = 'VoiceIntentError';
    this.cause = cause;
    this.modelUnavailable = modelUnavailable;
    // Preserve the original stack so the server log shows the real failure
    // point instead of only the wrapper's message.
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

let client: GoogleGenAI | null = null;

/** Test seam: swap the Gemini client (scripted model output, no network). Pass null to restore. */
export function __setVoiceIntentClientForTests(fake: GoogleGenAI | null): void {
  client = fake;
}

/**
 * Below this, a real (non-UNRECOGNIZED) intent is coerced to an
 * UNRECOGNIZED-shaped response before it reaches the client — the model
 * attempted a match but wasn't confident enough to execute unattended.
 * The ORIGINAL attempted intent/confidence is still what gets logged
 * (see routes/voice.ts's /parse-intent handler + interactionLog.ts) —
 * only the client-facing response is coerced.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

export async function buildContext(user: { id: string; systemRole: SystemRole; fullName: string; locationId: string }): Promise<PromptContext> {
  // Everything the model is told about "now" must be in the VENUE's local
  // zone, not UTC. A Dubai (UTC+4) venue's 00:00-04:00 — exactly when a
  // closing shift ends — is still the previous UTC day, so a UTC "today"
  // would make a spoken "tomorrow" resolve one calendar day early. That
  // wrong date is still a syntactically valid one, so /execute's
  // round-trip validity check cannot catch it: it has to be right here.
  const timezone = await venueTimezoneFor(user.locationId);
  const today = venueToday(timezone);
  const staff = await prisma.user.findMany({
    where: { locationId: user.locationId, isActive: true },
    select: { id: true, fullName: true },
  });

  const ctx: PromptContext = {
    today,
    callerName: user.fullName,
    callerShifts: [],
    staffDirectory: staff,
  };

  const startOfToday = new Date(`${today}T00:00:00.000Z`);
  const shifts = await prisma.shift.findMany({
    where: { userId: user.id, date: { gte: startOfToday } },
    orderBy: { date: 'asc' },
    take: 10,
  });
  // `date` is stored as UTC-midnight-of-the-venue-local-day, so slicing it
  // directly is already the venue-local calendar day. The start/end INSTANTS
  // are not — they go through the same `formatVenueTime` the REST shift DTO
  // (server/src/routes/shifts.ts) uses.
  ctx.callerShifts = shifts.map((s) => ({
    id: s.id,
    date: s.date.toISOString().slice(0, 10),
    startTime: formatVenueTime(s.startTime, timezone),
    endTime: formatVenueTime(s.endTime, timezone),
  }));

  // Pending decisions are only ever surfaced to manager-tier callers — a
  // STAFF caller never sees swap/join request ids at all, so the model has
  // nothing to point at even before the schema itself rules the intents out.
  if (user.systemRole !== 'STAFF') {
    const pendingSwaps = await prisma.shiftSwapRequest.findMany({
      where: { status: 'PENDING', shift: { locationId: user.locationId } },
      include: { requestedBy: { select: { fullName: true } }, targetUser: { select: { fullName: true } }, shift: { select: { date: true, startTime: true, endTime: true } } },
      take: 20,
    });
    ctx.pendingSwapRequests = pendingSwaps.map((r) => ({
      id: r.id,
      requesterName: r.requestedBy.fullName,
      coverName: r.targetUser?.fullName ?? null,
      shiftLabel: `${r.shift.date.toISOString().slice(0, 10)} ${formatVenueTime(r.shift.startTime, timezone)}-${formatVenueTime(r.shift.endTime, timezone)}`,
    }));

    const pendingJoins = await prisma.joinRequest.findMany({
      where: { locationId: user.locationId, status: 'PENDING' },
      take: 20,
    });
    ctx.pendingJoinRequests = pendingJoins.map((r) => ({ id: r.id, fullName: r.fullName, phone: r.phone }));

    const roles = await prisma.role.findMany({ where: { locationId: user.locationId }, select: { id: true, name: true } });
    ctx.roles = roles;

    const sections = await prisma.floorSection.findMany({ where: { locationId: user.locationId }, select: { id: true, label: true } });
    ctx.floorSections = sections;

    // For APPLY_ROTA_TEMPLATE — a per-location list of saved templates, not
    // a growing-over-time collection like shifts, so no bounded-window
    // concern here (see spec 2026-09-11-voice-publish-rota-apply-template-design.md §7.2).
    const templates = await prisma.rotaTemplate.findMany({ where: { locationId: user.locationId }, select: { id: true, name: true } });
    ctx.rotaTemplates = templates;

    const weekEnd = new Date(startOfToday);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    const venueShifts = await prisma.shift.findMany({
      where: { locationId: user.locationId, date: { gte: startOfToday, lt: weekEnd } },
      include: { role: { select: { name: true } }, assignee: { select: { fullName: true } } },
      orderBy: { date: 'asc' },
      take: 200,
    });
    ctx.weekShifts = venueShifts.map((s) => ({
      id: s.id,
      roleName: s.role.name,
      date: s.date.toISOString().slice(0, 10),
      start: formatVenueTime(s.startTime, timezone),
      end: formatVenueTime(s.endTime, timezone),
      assigneeName: s.assignee?.fullName ?? null,
    }));
  }

  return ctx;
}

/**
 * Parses a transcript into a role-scoped intent. Never mutates anything —
 * this is the "propose" half of the confirm-before-execute boundary. The
 * caller's role restricts BOTH the Gemini response schema (the model
 * structurally cannot emit an out-of-scope intent) and the prompt text
 * (defense-in-depth) — but /execute must still re-check role independently,
 * since this function's output is not itself a trust boundary.
 */
export interface VoiceIntentResolution {
  /** What the client should see/act on — coerced to UNRECOGNIZED if below CONFIDENCE_THRESHOLD. */
  response: ParsedIntent;
  /** What the model actually returned, uncoerced — always logged as-is. */
  attempted: ParsedIntent;
  /** What the model reported for hasAdditionalRequest, uncoerced — always logged as-is (see interactionLog.ts), regardless of what outcome/response the caller ends up seeing. */
  hasAdditionalRequest: boolean;
}

export async function parseVoiceIntent(
  transcript: string,
  user: { id: string; systemRole: SystemRole; fullName: string; locationId: string },
): Promise<VoiceIntentResolution> {
  if (!client) {
    let options: ReturnType<typeof voiceClientOptions>;
    try {
      options = voiceClientOptions();
    } catch (err) {
      throw new VoiceIntentError(err instanceof Error ? err.message : 'Voice AI credentials could not be read.', err);
    }
    if (!options) {
      const unconfigured = new VoiceIntentError('No AI backend is configured (GEMINI_VERTEX_PROJECT or GEMINI_API_KEY) — voice intent parsing is unavailable.');
      unconfigured.notConfigured = true;
      throw unconfigured;
    }
    client = new GoogleGenAI(options);
  }

  const context = await buildContext(user);
  const systemPrompt = buildSystemPrompt(user.systemRole, context);
  const schema = intentSchemaFor(user.systemRole);

  try {
    const genai = client;
    const response = await withAiBudget(
      { locationId: user.locationId, userId: user.id, feature: 'voice_intent', inputTokensEstimate: textInputEstimate(systemPrompt, transcript, JSON.stringify(schema)) },
      async () => {
        const r = await genai.models.generateContent({
          model: voiceModel(),
          contents: [{ role: 'user', parts: [{ text: transcript }] }],
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
            responseSchema: schema,
            maxOutputTokens: MAX_OUTPUT_TOKENS.voice_intent,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        });
        return { value: r, usage: { inputTokens: r.usageMetadata?.promptTokenCount ?? null, outputTokens: billedOutputTokens(r.usageMetadata) } };
      },
    );
    const raw = JSON.parse(response.text ?? '{}');
    const attempted = normalizeParsedIntent(raw);
    // Computed independently of confidence/the gate below — this line must
    // never move inside either branch of that gate.
    const hasAdditionalRequest = normalizeHasAdditionalRequest(raw);
    let clientResponse: ParsedIntent =
      attempted.intent === 'UNRECOGNIZED' || attempted.confidence >= CONFIDENCE_THRESHOLD
        ? attempted
        : {
            intent: 'UNRECOGNIZED',
            reason: `I understood this as "${attempted.summary}" but wasn't confident enough to act on it without you rephrasing.`,
            summary: 'Could not confidently resolve this command.',
          };

    // PUBLISH_ROTA/APPLY_ROTA_TEMPLATE get a further, deterministic
    // refinement pass on top of the confidence gate above — see spec
    // 2026-09-11-voice-publish-rota-apply-template-design.md §2.1/§2.2.
    // `attempted` (used for logging) is untouched by this; only the
    // client-facing `clientResponse` is refined further.
    if (clientResponse.intent === 'PUBLISH_ROTA') {
      clientResponse = await refinePublishRotaResponse(clientResponse, user.locationId);
    } else if (clientResponse.intent === 'APPLY_ROTA_TEMPLATE') {
      clientResponse = await refineApplyRotaTemplateResponse(clientResponse, context.rotaTemplates ?? []);
    }
    const timezone = await venueTimezoneFor(user.locationId);
    clientResponse = await checkAgainstContext(clientResponse, context, user, timezone, transcript);
    // Below the confidence gate, but the model named two or three concrete readings (approve or
    // decline?): offer the ones that pass every check a confident answer must pass as choices,
    // instead of asking to rephrase. Picking one only opens the normal confirm sheet.
    if (clientResponse.intent === 'UNRECOGNIZED' && attempted.intent !== 'UNRECOGNIZED' && attempted.confidence < CONFIDENCE_THRESHOLD) {
      const options = await offerableReadings([attempted, ...normalizeAlternatives(raw)], context, user, timezone, transcript);
      if (options.length >= 2) clientResponse = { ...clientResponse, summary: WHICH_DID_YOU_MEAN, options };
    }

    return { response: clientResponse, attempted, hasAdditionalRequest };
  } catch (err) {
    if (err instanceof AiBudgetExceededError) {
      const paused = new VoiceIntentError(`AI spend cap reached (${err.limit}); no call made.`, err);
      paused.paused = true;
      paused.limit = err.limit;
      throw paused;
    }
    if (err instanceof ApiError) {
      const modelUnavailable = reportIfModelUnavailable('parse-intent', err);
      throw new VoiceIntentError(`Intent parsing failed (${err.status ?? 'unknown'}): ${err.message}`, err, modelUnavailable);
    }
    if (err instanceof VoiceIntentError) throw err;
    throw new VoiceIntentError('Unexpected error while parsing the voice command.', err);
  }
}

/**
 * A missing/non-boolean value fails CLOSED to false — an absent flag must
 * never fabricate a "there's more" prompt the model didn't actually make.
 */
export function normalizeHasAdditionalRequest(raw: Record<string, unknown>): boolean {
  return typeof raw.hasAdditionalRequest === 'boolean' ? raw.hasAdditionalRequest : false;
}

/**
 * PUBLISH_ROTA's confirm-preview must state the exact affected shift/staff
 * count (spec 2026-09-11-voice-publish-rota-apply-template-design.md §2.1) —
 * the model is never trusted to both look up and arithmetic-check that
 * number from context, so this recomputes it directly via the same groupBy
 * `publishRota` itself uses, and overwrites `summary` with a deterministic
 * string. An empty target week short-circuits to a rejection instead of a
 * "publish 0 shifts — confirm?" preview.
 */
export async function refinePublishRotaResponse(
  response: Extract<ParsedIntent, { intent: 'PUBLISH_ROTA' }>,
  locationId: string,
): Promise<ParsedIntent> {
  const weekStart = new Date(`${response.weekStart}T00:00:00.000Z`);
  if (Number.isNaN(weekStart.getTime())) {
    return { intent: 'UNRECOGNIZED', reason: 'Could not resolve a valid week for this request.', summary: 'Could not determine which week to publish.' };
  }
  const { shiftCount, staffCount } = await getRotaPublishPreview(locationId, weekStart);
  if (shiftCount === 0) {
    return {
      intent: 'UNRECOGNIZED',
      reason: `No shifts exist for the week of ${response.weekStart} yet.`,
      summary: `There are no shifts scheduled for the week of ${response.weekStart} yet — nothing to publish.`,
    };
  }
  const summary = `This will publish ${shiftCount} shift${shiftCount === 1 ? '' : 's'} across ${staffCount} staff member${staffCount === 1 ? '' : 's'} for the week of ${response.weekStart} — confirm?`;
  return { ...response, summary };
}

const TEMPLATE_MATCH_THRESHOLD = 0.6;
const TEMPLATE_MATCH_MARGIN = 0.1;

/**
 * APPLY_ROTA_TEMPLATE's ambiguity backstop (spec §2.2) — independently
 * re-scores the model's own templateId/templateName against the caller's
 * real saved templates instead of trusting the model's stated confidence
 * alone for a same-shape judgment (the failure mode the task explicitly
 * warns against: an opaque decision executed silently). Resolves only when
 * the model's own pick agrees with the best-scoring match AND that match
 * clears both an absolute floor and a margin over the runner-up; otherwise
 * responds with a clarifying question rather than applying the closest guess.
 */
export async function refineApplyRotaTemplateResponse(
  response: Extract<ParsedIntent, { intent: 'APPLY_ROTA_TEMPLATE' }>,
  templates: { id: string; name: string }[],
): Promise<ParsedIntent> {
  const weekStart = new Date(`${response.weekStart}T00:00:00.000Z`);
  if (Number.isNaN(weekStart.getTime())) {
    return { intent: 'UNRECOGNIZED', reason: 'Could not resolve a valid week for this request.', summary: 'Could not determine which week to apply the template to.' };
  }
  const { best, runnerUp } = bestMatch(response.templateName, templates);
  const confidentMatch =
    best !== null &&
    best.score >= TEMPLATE_MATCH_THRESHOLD &&
    (!runnerUp || best.score - runnerUp.score >= TEMPLATE_MATCH_MARGIN) &&
    response.templateId === best.id;

  if (!confidentMatch || !best) {
    const candidates = [best, runnerUp].filter((c): c is NonNullable<typeof c> => c !== null).map((c) => `"${c.name}"`);
    const reason =
      candidates.length > 0
        ? `Not confident which saved template "${response.templateName}" refers to — closest matches: ${candidates.join(', ')}.`
        : `No saved template resembling "${response.templateName}" was found.`;
    return {
      intent: 'UNRECOGNIZED',
      reason,
      summary:
        candidates.length > 0
          ? `I'm not sure which saved template you meant — did you mean ${candidates.join(' or ')}? Please say the template name again.`
          : `I couldn't find a saved template matching "${response.templateName}". Please say the template name again.`,
    };
  }

  const summary = `Apply template "${best.name}" to the week of ${response.weekStart} — confirm?`;
  return { ...response, templateId: best.id, summary };
}

/** At most this many choices on a "which did you mean?" sheet. */
export const MAX_VOICE_OPTIONS = 3;
export const WHICH_DID_YOU_MEAN = 'Which did you mean?';

/** The model's other readings (`alternatives`), normalized like the main answer. */
function normalizeAlternatives(raw: Record<string, unknown>): ParsedIntent[] {
  const list = raw.alternatives;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, MAX_VOICE_OPTIONS - 1)
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .map((a) => normalizeParsedIntent(a));
}

/**
 * The readings the caller may choose between: each goes through the same refinements and
 * `checkAgainstContext` as a confident answer (the caller's role, ids in the caller's own venue,
 * no past dates, no overlaps), so a choice can only ever be something the confirm sheet could
 * have offered on its own. Duplicates and non-actions are dropped.
 */
async function offerableReadings(
  readings: ParsedIntent[],
  ctx: PromptContext,
  caller: { id: string; systemRole: SystemRole; locationId: string },
  timezone: string,
  transcript: string,
): Promise<ChoosableIntent[]> {
  const options: ChoosableIntent[] = [];
  const seen = new Set<string>();
  for (const reading of readings) {
    if (options.length === MAX_VOICE_OPTIONS) break;
    let checked = reading;
    if (checked.intent === 'PUBLISH_ROTA') checked = await refinePublishRotaResponse(checked, caller.locationId);
    else if (checked.intent === 'APPLY_ROTA_TEMPLATE') checked = await refineApplyRotaTemplateResponse(checked, ctx.rotaTemplates ?? []);
    checked = await checkAgainstContext(checked, ctx, caller, timezone, transcript);
    if (checked.intent === 'UNRECOGNIZED' || checked.intent === 'QUERY_MY_SCHEDULE') continue;
    const key = JSON.stringify({ ...checked, confidence: 0, summary: '' });
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(checked);
  }
  return options;
}

function clarify(reason: string, summary: string): ParsedIntent {
  return { intent: 'UNRECOGNIZED', reason, summary };
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * When the caller named exactly one weekday and the resolved date is a different weekday, ask
 * again instead of offering the wrong day ("Friday" resolved to a Saturday).
 */
export function weekdayMismatch(transcript: string, response: ParsedIntent): ParsedIntent | null {
  const said = WEEKDAY_NAMES.map((d, i) => (new RegExp(`\\b${d}\\b`, 'i').test(transcript) ? i : -1)).filter((i) => i >= 0);
  if (said.length !== 1) return null;
  const date =
    response.intent === 'MARK_AVAILABILITY' || response.intent === 'CREATE_SHIFT' || response.intent === 'EDIT_SHIFT'
      ? response.date
      : response.intent === 'ASSIGN_SECTION'
        ? response.shiftDate
        : undefined;
  if (!date) return null;
  const actual = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  if (Number.isNaN(actual) || actual === said[0]) return null;
  return clarify(
    `The caller said ${WEEKDAY_NAMES[said[0]!]}, but ${date} is a ${WEEKDAY_NAMES[actual]}.`,
    `You said ${WEEKDAY_NAMES[said[0]!]}, but that date is a ${WEEKDAY_NAMES[actual]}. Which day did you mean?`,
  );
}

const NOT_FOUND = (what: string) => clarify(`The ${what} wasn't one this venue has.`, `I couldn't find that ${what} at your venue. Please say it again.`);
const PAST_DATE = clarify('The date resolved to a day that has already passed.', 'That day has already passed. Which day did you mean?');

/**
 * Propose-time backstop, after the model and the refinements above: the
 * confirm sheet must never offer something /execute would refuse, or that
 * the caller didn't say. Everything here is deterministic and checked against
 * the same lists the model was given (`buildContext`), so a model that
 * ignores its schema or invents an id is caught before a Confirm button shows:
 *  - an intent outside the caller's role;
 *  - any id (person, shift, section, role, request) not in the caller's venue lists;
 *  - a date that has already passed (availability, new shifts, edits, section assignments);
 *  - a new shift that overlaps the person's existing shift.
 * /execute still re-checks everything on its own.
 */
export async function checkAgainstContext(
  response: ParsedIntent,
  ctx: PromptContext,
  caller: { id: string; systemRole: SystemRole; locationId: string },
  timezone: string,
  transcript = '',
): Promise<ParsedIntent> {
  if (response.intent === 'UNRECOGNIZED') return response;
  if (!allowedIntentsFor(caller.systemRole).includes(response.intent)) {
    // The app recognises this exact reason and shows its role-refusal message (shared contract).
    return clarify(VOICE_ROLE_REFUSAL, VOICE_ROLE_REFUSAL);
  }
  const mismatch = weekdayMismatch(transcript, response);
  if (mismatch) return mismatch;
  const staff = new Set(ctx.staffDirectory.map((s) => s.id));
  const isPast = (date: string | undefined) => date !== undefined && date < ctx.today;
  switch (response.intent) {
    case 'MARK_AVAILABILITY':
      return isPast(response.date) ? PAST_DATE : response;
    case 'REQUEST_SWAP':
      if (!ctx.callerShifts.some((s) => s.id === response.shiftId)) return NOT_FOUND('shift of yours');
      if (!staff.has(response.targetUserId) || response.targetUserId === caller.id) return NOT_FOUND('colleague');
      return response;
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      return (ctx.pendingSwapRequests ?? []).some((r) => r.id === response.swapRequestId) ? response : NOT_FOUND('pending swap request');
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      return (ctx.pendingJoinRequests ?? []).some((r) => r.id === response.joinRequestId) ? response : NOT_FOUND('pending join request');
    case 'CREATE_SHIFT': {
      if (!(ctx.roles ?? []).some((r) => r.id === response.roleId)) return NOT_FOUND('role');
      if (response.userId !== null && !staff.has(response.userId)) return NOT_FOUND('person');
      if (isPast(response.date)) return PAST_DATE;
      if (response.userId !== null) {
        const overnight = response.end <= response.start;
        const start = combineDateAndTime(response.date, response.start, timezone);
        const end = combineDateAndTime(response.date, response.end, timezone, overnight);
        const clash = await prisma.shift.findFirst({
          where: { userId: response.userId, locationId: caller.locationId, status: { not: 'CANCELLED' }, startTime: { lt: end }, endTime: { gt: start } },
          select: { startTime: true, endTime: true },
        });
        if (clash) {
          const when = `${formatVenueTime(clash.startTime, timezone)}–${formatVenueTime(clash.endTime, timezone)}`;
          return clarify(`That person already works ${when} then.`, `They already have a shift ${when} that overlaps. Pick another time or person.`);
        }
      }
      return response;
    }
    case 'EDIT_SHIFT':
      if (!(ctx.weekShifts ?? []).some((s) => s.id === response.shiftId)) return NOT_FOUND('shift');
      if (response.roleId !== undefined && !(ctx.roles ?? []).some((r) => r.id === response.roleId)) return NOT_FOUND('role');
      if (typeof response.userId === 'string' && !staff.has(response.userId)) return NOT_FOUND('person');
      return isPast(response.date) ? PAST_DATE : response;
    case 'ASSIGN_SECTION':
      if (!(ctx.floorSections ?? []).some((s) => s.id === response.sectionId)) return NOT_FOUND('section');
      if (!staff.has(response.staffId)) return NOT_FOUND('person');
      return isPast(response.shiftDate) ? PAST_DATE : response;
    case 'POST_SHOUTOUT':
      return staff.has(response.targetUserId) ? response : NOT_FOUND('person');
    default:
      return response;
  }
}

/**
 * Narrows Gemini's loosely-typed JSON object into the real ParsedIntent
 * union, defaulting to UNRECOGNIZED on any shape mismatch rather than
 * trusting an unexpected field combination. The response schema already
 * makes most of these mismatches structurally impossible, but this is the
 * defense-in-depth layer that never trusts the raw JSON at face value.
 */
export function normalizeParsedIntent(raw: Record<string, unknown>): ParsedIntent {
  const intent = typeof raw.intent === 'string' ? raw.intent : 'UNRECOGNIZED';
  const summary = typeof raw.summary === 'string' ? raw.summary : 'Could not determine what to do.';
  // A missing/non-numeric/out-of-range confidence fails CLOSED to 0 — an
  // absent score must never be treated as "the model was certain."
  const rawConfidence = raw.confidence;
  const confidence = typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : 0;

  switch (intent) {
    case 'MARK_AVAILABILITY':
      if (typeof raw.date === 'string' && (raw.availabilityType === 'UNAVAILABLE' || raw.availabilityType === 'PREFERRED_OFF')) {
        return { intent: 'MARK_AVAILABILITY', date: raw.date, type: raw.availabilityType, confidence, summary };
      }
      break;
    case 'REQUEST_SWAP':
      if (typeof raw.shiftId === 'string' && typeof raw.targetUserId === 'string') {
        return {
          intent: 'REQUEST_SWAP',
          shiftId: raw.shiftId,
          targetUserId: raw.targetUserId,
          targetUserName: typeof raw.targetUserName === 'string' ? raw.targetUserName : '',
          reason: typeof raw.reason === 'string' ? raw.reason : null,
          confidence,
          summary,
        };
      }
      break;
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      if (typeof raw.swapRequestId === 'string') {
        return { intent, swapRequestId: raw.swapRequestId, confidence, summary };
      }
      break;
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      if (typeof raw.joinRequestId === 'string') {
        return { intent, joinRequestId: raw.joinRequestId, confidence, summary };
      }
      break;
    case 'CREATE_SHIFT':
      if (typeof raw.roleId === 'string' && typeof raw.date === 'string' && typeof raw.start === 'string' && typeof raw.end === 'string') {
        return {
          intent: 'CREATE_SHIFT',
          roleId: raw.roleId,
          date: raw.date,
          start: raw.start,
          end: raw.end,
          userId: typeof raw.userId === 'string' ? raw.userId : null,
          confidence,
          summary,
        };
      }
      break;
    case 'EDIT_SHIFT':
      if (typeof raw.shiftId === 'string') {
        return {
          intent: 'EDIT_SHIFT',
          shiftId: raw.shiftId,
          roleId: typeof raw.roleId === 'string' ? raw.roleId : undefined,
          date: typeof raw.date === 'string' ? raw.date : undefined,
          start: typeof raw.start === 'string' ? raw.start : undefined,
          end: typeof raw.end === 'string' ? raw.end : undefined,
          userId: typeof raw.userId === 'string' || raw.userId === null ? raw.userId : undefined,
          confidence,
          summary,
        };
      }
      break;
    case 'PUBLISH_ROTA':
      if (typeof raw.weekStart === 'string') {
        return { intent: 'PUBLISH_ROTA', weekStart: raw.weekStart, confidence, summary };
      }
      break;
    case 'APPLY_ROTA_TEMPLATE':
      if (typeof raw.weekStart === 'string' && typeof raw.templateName === 'string') {
        return {
          intent: 'APPLY_ROTA_TEMPLATE',
          templateId: typeof raw.templateId === 'string' ? raw.templateId : null,
          templateName: raw.templateName,
          weekStart: raw.weekStart,
          confidence,
          summary,
        };
      }
      break;
    case 'POST_ANNOUNCEMENT':
      if (typeof raw.content === 'string') {
        return { intent: 'POST_ANNOUNCEMENT', content: raw.content, confidence, summary };
      }
      break;
    case 'POST_SHOUTOUT':
      if (typeof raw.targetUserId === 'string' && typeof raw.content === 'string') {
        return {
          intent: 'POST_SHOUTOUT',
          targetUserId: raw.targetUserId,
          targetUserName: typeof raw.targetUserName === 'string' ? raw.targetUserName : '',
          content: raw.content,
          confidence,
          summary,
        };
      }
      break;
    case 'QUERY_MY_SCHEDULE':
      return { intent: 'QUERY_MY_SCHEDULE', confidence, summary };
    case 'ASSIGN_SECTION':
      if (typeof raw.sectionId === 'string' && typeof raw.staffId === 'string' && typeof raw.shiftDate === 'string' && (raw.period === 'AM' || raw.period === 'PM')) {
        return {
          intent: 'ASSIGN_SECTION',
          sectionId: raw.sectionId,
          staffId: raw.staffId,
          shiftDate: raw.shiftDate,
          period: raw.period,
          dutyLabel: typeof raw.dutyLabel === 'string' ? raw.dutyLabel : null,
          confidence,
          summary,
        };
      }
      break;
  }
  return {
    intent: 'UNRECOGNIZED',
    reason: typeof raw.unrecognizedReason === 'string' ? raw.unrecognizedReason : 'Could not confidently match this to a supported command.',
    summary,
  };
}
