import { GoogleGenAI, ApiError, ThinkingLevel } from '@google/genai';
import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { allowedIntentsFor, intentSchemaFor, type ChoosableIntent, type ParsedIntent, type PersonQuestion, type ReadingDetails } from './intentSchema.js';
import { MAX_PEOPLE_CHOICES, nameFits, normalizeName, resolvePerson, type PersonResolution, type StaffEntry } from './people.js';
import { combineDateAndTime } from '../parsing/normalize.js';
import { repeatsSentence, VOICE_ROLE_REFUSAL } from '../../../shared/voiceIntents.js';
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
    ctx.pendingSwapRequests = pendingSwaps.map((r) => {
      const shift = { date: r.shift.date.toISOString().slice(0, 10), start: formatVenueTime(r.shift.startTime, timezone), end: formatVenueTime(r.shift.endTime, timezone) };
      return {
        id: r.id,
        requesterName: r.requestedBy.fullName,
        coverName: r.targetUser?.fullName ?? null,
        shiftLabel: `${shift.date} ${shift.start}-${shift.end}`,
        shift,
      };
    });

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
            // The same words should get the same answer: no sampling variety (seen live run to run).
            temperature: 0,
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
    const lowConfidence = attempted.intent !== 'UNRECOGNIZED' && attempted.confidence < CONFIDENCE_THRESHOLD;
    let clientResponse: ParsedIntent = lowConfidence ? lowConfidenceResponse(attempted.summary) : attempted;
    // A recognised command missing something it needs: ask for exactly that, not "didn't catch that".
    if (attempted.intent === 'UNRECOGNIZED') clientResponse = askForMissing(raw, context, user, transcript) ?? clientResponse;

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
    if (lowConfidence) {
      // A person the server couldn't pin down (nobody by that name, or more than one) is asked
      // about directly, whatever the model's confidence: often that is exactly why it was unsure.
      // Every choice is still a complete, checked reading that runs only after its own Confirm.
      const own = await checkAgainstContext(attempted, context, user, timezone, transcript);
      if (own.intent === 'UNRECOGNIZED' && own.person) {
        clientResponse = own;
      } else {
        // The model named two or three concrete readings (approve or decline?): offer the ones that
        // pass every check a confident answer must pass as choices, instead of asking to rephrase.
        // Picking one only opens the normal confirm sheet.
        const options = await offerableReadings([attempted, ...normalizeAlternatives(raw)], context, user, timezone, transcript);
        if (options.length >= 2) clientResponse = { intent: 'UNRECOGNIZED', summary: WHICH_DID_YOU_MEAN, reason: PICK_ONE, options };
      }
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
    return { intent: 'UNRECOGNIZED', reason: WHICH_WEEK_HINT, summary: 'Which week should I publish?' };
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
    return { intent: 'UNRECOGNIZED', reason: WHICH_WEEK_HINT, summary: 'Which week should I use the template for?' };
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
        ? `I'm not sure which saved template "${response.templateName}" is — closest matches: ${candidates.join(', ')}.`
        : `There's no saved template like "${response.templateName}" at your venue.`;
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
const PICK_ONE = 'Pick one to see exactly what will happen. Nothing changes until you confirm.';

/**
 * Everything the caller reads on a "not understood" sheet is written for them, never for us:
 * no "intent", "supported command" or other internals (the old fallback, "Could not confidently
 * match this to a supported command.", was what a phone showed for a shout-out to someone the
 * venue didn't have).
 */
export const VOICE_DIDNT_CATCH = "I didn't catch what you'd like to do.";
export const VOICE_TRY_AGAIN = 'Try again with who, what and when — for example "Mark me unavailable on Friday".';
const WHICH_WEEK_HINT = 'Say the week, for example "this week" or "next week".';
/** Model text that reads like a log line, not a sentence for the caller. */
const JARGON = /\bintents?\b|supported command|\bschema\b|\bjson\b|\bunrecognized\b|\bids?\b|could not (confidently )?(match|resolve|determine)/i;

/** The model's own sentence for the caller, if it wrote one that reads like one. */
function forCaller(text: unknown): string | null {
  return typeof text === 'string' && text.trim() && !JARGON.test(text) ? text.trim() : null;
}

/** Below the confidence gate: say what it sounded like, and how to fix it. */
function lowConfidenceResponse(summary: string): ParsedIntent {
  const heard = summary.trim().replace(/[.!?]+$/, '');
  return {
    intent: 'UNRECOGNIZED',
    reason: heard
      ? `It sounded like "${heard}", but I'd rather check than guess. Say it again, or fix what I heard and try again.`
      : 'Say it again, or fix what I heard and try again.',
    summary: "I'm not sure I got that right.",
  };
}

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
    `Say the day again, or fix what I heard and try again.`,
    `You said ${WEEKDAY_NAMES[said[0]!]}, but that date is a ${WEEKDAY_NAMES[actual]}. Which day did you mean?`,
  );
}

const NOT_FOUND = (what: string) => clarify('Say it again, or fix what I heard and try again.', `I couldn't find that ${what} at your venue.`);
const PAST_DATE = clarify('Pick a day from today onwards.', 'That day has already passed. Which day did you mean?');

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
  // The person a command names is looked up in the caller's own venue, never taken on the model's
  // word: nobody by that name, or more than one, is put to the caller as a question.
  // "Move Alex's shift to 7pm": a name that is whose shift it already is names no new person.
  if (response.intent === 'EDIT_SHIFT' && response.userId === null && response.targetUserName?.trim()) {
    const { shiftId } = response;
    const current = (ctx.weekShifts ?? []).find((s) => s.id === shiftId)?.assigneeName;
    if (current && nameFits(response.targetUserName, current)) response = { ...response, userId: undefined, targetUserName: undefined };
  }
  const slot = personSlot(response);
  if (slot) {
    const found = resolvePerson(slot.heard, slot.id, ctx.staffDirectory, transcript, caller.id);
    if (found.kind === 'one') response = withPerson(response, found.person);
    else if (found.kind !== 'unknown') return askWhichPerson(response, found, ctx, caller, timezone, transcript);
    // 'unknown' (no name, and an id from nowhere) is refused by the checks below.
  }
  const checked = await checkIds(response, ctx, caller, timezone);
  return checked.intent === 'UNRECOGNIZED' ? checked : withDetails(checked, ctx);
}

/** The id, date and overlap checks behind `checkAgainstContext`, for a reading whose person is settled. */
async function checkIds(
  response: Exclude<ParsedIntent, { intent: 'UNRECOGNIZED' }>,
  ctx: PromptContext,
  caller: { id: string; locationId: string },
  timezone: string,
): Promise<ParsedIntent> {
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

type Reading = Exclude<ParsedIntent, { intent: 'UNRECOGNIZED' }>;

/**
 * The person a reading names, if it names one: the name as said and the id the model picked.
 * CREATE_SHIFT/EDIT_SHIFT with no one named are an open shift, or (EDIT_SHIFT) a shift whose
 * person stays the same or is taken off; there is nobody to look up.
 */
function personSlot(r: Reading): { heard: string; id: string | null } | null {
  switch (r.intent) {
    case 'REQUEST_SWAP':
    case 'POST_SHOUTOUT':
      return { heard: r.targetUserName, id: r.targetUserId || null };
    case 'ASSIGN_SECTION':
      return { heard: r.targetUserName ?? '', id: r.staffId || null };
    case 'CREATE_SHIFT':
    case 'EDIT_SHIFT':
      if (r.userId === undefined || (r.userId === null && !r.targetUserName?.trim())) return null;
      return { heard: r.targetUserName ?? '', id: r.userId };
    default:
      return null;
  }
}

/** The reading with this person in it, named as the venue's staff list names them. */
function withPerson(r: Reading, p: StaffEntry): Reading {
  switch (r.intent) {
    case 'REQUEST_SWAP':
    case 'POST_SHOUTOUT':
      return { ...r, targetUserId: p.id, targetUserName: p.fullName };
    case 'ASSIGN_SECTION':
      return { ...r, staffId: p.id, targetUserName: p.fullName };
    case 'CREATE_SHIFT':
    case 'EDIT_SHIFT':
      return { ...r, userId: p.id, targetUserName: p.fullName };
    default:
      return r;
  }
}

/** "Sat 10 Oct" for a YYYY-MM-DD venue day. */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Names for the confirm sheet's preview, from the caller's own venue lists only (never a phone number). */
function describeReading(r: Reading, ctx: PromptContext): ReadingDetails | undefined {
  const nameOf = (id: string) => ctx.staffDirectory.find((s) => s.id === id)?.fullName ?? null;
  const roleOf = (id: string) => (ctx.roles ?? []).find((x) => x.id === id)?.name;
  switch (r.intent) {
    case 'POST_SHOUTOUT':
      return { person: nameOf(r.targetUserId) };
    case 'REQUEST_SWAP': {
      const s = ctx.callerShifts.find((x) => x.id === r.shiftId);
      return { person: nameOf(r.targetUserId), ...(s ? { shift: { date: s.date, start: s.startTime, end: s.endTime } } : {}) };
    }
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP': {
      const q = (ctx.pendingSwapRequests ?? []).find((x) => x.id === r.swapRequestId);
      return q ? { person: q.requesterName, cover: q.coverName ?? null, ...(q.shift ? { shift: q.shift } : {}) } : undefined;
    }
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN': {
      const j = (ctx.pendingJoinRequests ?? []).find((x) => x.id === r.joinRequestId);
      return j ? { person: j.fullName } : undefined;
    }
    case 'CREATE_SHIFT':
      return { person: r.userId ? nameOf(r.userId) : null, role: roleOf(r.roleId) };
    case 'EDIT_SHIFT': {
      const s = (ctx.weekShifts ?? []).find((x) => x.id === r.shiftId);
      return {
        ...(r.userId !== undefined ? { person: r.userId ? nameOf(r.userId) : null } : {}),
        ...(r.roleId ? { role: roleOf(r.roleId) } : {}),
        ...(s ? { shift: { date: s.date, start: s.start, end: s.end, role: s.roleName, person: s.assigneeName } } : {}),
      };
    }
    case 'ASSIGN_SECTION':
      return { person: nameOf(r.staffId), section: (ctx.floorSections ?? []).find((x) => x.id === r.sectionId)?.label };
    default:
      return undefined;
  }
}

function withDetails(r: Reading, ctx: PromptContext): Reading {
  const details = describeReading(r, ctx);
  return details ? { ...r, details } : r;
}

/** A person choice's own sentence: the model's summary named whoever it picked, not this person. */
function personSummary(r: Reading): string {
  const d = r.details ?? {};
  const name = d.person ?? 'them';
  switch (r.intent) {
    case 'POST_SHOUTOUT':
      return `Give ${name} a shout-out.`;
    case 'REQUEST_SWAP':
      return d.shift ? `Ask ${name} to cover your ${dayLabel(d.shift.date)} shift.` : `Ask ${name} to cover your shift.`;
    case 'CREATE_SHIFT':
      return `Create a ${d.role ? `${d.role} ` : ''}shift for ${name}, ${dayLabel(r.date)} ${r.start}–${r.end}.`;
    case 'EDIT_SHIFT':
      return d.shift ? `Give the ${dayLabel(d.shift.date)} ${d.shift.start}–${d.shift.end} shift to ${name}.` : `Give that shift to ${name}.`;
    case 'ASSIGN_SECTION':
      return `Put ${name} on ${d.section ?? 'that section'}, ${dayLabel(r.shiftDate)} ${r.period}.`;
    default:
      return r.summary;
  }
}

/** "Rana" appears in what the caller said (word for word, ignoring case and punctuation). */
function saidAloud(name: string, transcript: string): boolean {
  const n = normalizeName(name);
  return n.length > 0 && ` ${normalizeName(transcript)} `.includes(` ${n} `);
}

/**
 * Nobody, or more than one person, at the caller's venue fits the name: a question for the
 * caller, with one complete reading per candidate (each checked like any other answer) to pick
 * from. Only the caller's own words are echoed back — never a name they didn't say, and never
 * anyone outside their venue (the candidates come from its staff list alone).
 */
async function askWhichPerson(
  reading: Reading,
  found: Extract<PersonResolution, { kind: 'ambiguous' | 'missing' }>,
  ctx: PromptContext,
  caller: { id: string; systemRole: SystemRole; locationId: string },
  timezone: string,
  transcript: string,
): Promise<ParsedIntent> {
  const candidates = found.kind === 'ambiguous' ? found.people : found.near;
  const options: ChoosableIntent[] = [];
  if (candidates.length <= MAX_PEOPLE_CHOICES) {
    for (const person of candidates) {
      const checked = await checkIds(withPerson(reading, person), ctx, caller, timezone);
      if (checked.intent === 'UNRECOGNIZED' || checked.intent === 'QUERY_MY_SCHEDULE') continue;
      const described = withDetails(checked, ctx);
      options.push({ ...described, summary: personSummary(described) } as ChoosableIntent);
    }
  }
  const choices = options.length ? { options } : {};

  if (found.kind === 'ambiguous') {
    const heard = found.heard;
    const sameName = candidates.every((p) => normalizeName(heard).split(' ').every((w) => normalizeName(p.fullName).split(' ').includes(w)));
    const summary = sameName ? `Which ${heard} did you mean?` : 'Who did you mean?';
    const reason =
      candidates.length > MAX_PEOPLE_CHOICES
        ? `${candidates.length} people on your team are called ${heard}. Say their full name and try again.`
        : options.length
          ? PICK_ONE
          : 'Say their full name and try again.';
    return { intent: 'UNRECOGNIZED', summary, reason, person: { heard, status: 'ambiguous' }, ...choices };
  }

  return missingPerson(found, caller, transcript, options);
}

/** "I couldn't find Rana on your team.", with any close names as choices and, for managers, where to add them. */
function missingPerson(
  found: Extract<PersonResolution, { kind: 'missing' }>,
  caller: { systemRole: SystemRole },
  transcript: string,
  options: ChoosableIntent[],
): ParsedIntent {
  const heard = saidAloud(found.heard, transcript) ? found.heard : '';
  const who = heard || 'that person';
  const canAddStaff = caller.systemRole !== 'STAFF';
  const addHint = canAddStaff ? `If ${heard || 'they'} ${heard ? 'is' : 'are'} new, add them in People first, then try again.` : 'Check the name and try again.';
  if (options.length) {
    const reason = `Did you mean ${options.length === 1 ? 'this person' : 'one of these'}? ${addHint}`;
    return { intent: 'UNRECOGNIZED', summary: `I couldn't find ${who} on your team.`, reason, person: { heard, status: 'missing' }, options };
  }
  // Close names, but no complete reading to offer (the command still lacks a part, e.g. the note):
  // name them, and offer the same words with the right name to read again.
  const near = found.near.map((p) => p.fullName);
  const reason = near.length ? `Did you mean ${near.join(' or ')}? ${addHint}` : addHint;
  const retry = heard
    ? near.map((person) => ({ person, text: withName(transcript, heard, person) })).filter((r) => r.text !== transcript)
    : [];
  return { intent: 'UNRECOGNIZED', summary: `I couldn't find ${who} on your team.`, reason, person: { heard, status: 'missing' }, ...(retry.length ? { retry } : {}) };
}

/** The transcript with the name as said swapped for a staff member's full name ("Give Alix…" → "Give Alex Morgan…"). */
function withName(transcript: string, heard: string, fullName: string): string {
  const escaped = heard.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return transcript.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu'), fullName);
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
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  // The name as said. A reading that names someone the model couldn't (or shouldn't) pick an id
  // for is kept, with an empty id, so checkAgainstContext can look the name up and ask the caller;
  // an empty id is never executable (/execute requires a non-empty one).
  const heardName = typeof raw.targetUserName === 'string' ? raw.targetUserName : '';
  const named = heardName.trim() !== '';
  // A missing/non-numeric/out-of-range confidence fails CLOSED to 0 — an
  // absent score must never be treated as "the model was certain."
  const rawConfidence = raw.confidence;
  const confidence = typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : 0;
  // Every key is required by the schema, so "not given" arrives as null — or, from a model that
  // ignores it, as "" or not at all. All three are the same here: missing.
  const missing = missingFields(raw);
  const value = (key: string) => text(raw[key]);

  if (!missing?.length) {
    switch (intent) {
      case 'MARK_AVAILABILITY':
        return { intent: 'MARK_AVAILABILITY', date: value('date')!, type: raw.availabilityType as 'UNAVAILABLE' | 'PREFERRED_OFF', confidence, summary };
      case 'REQUEST_SWAP':
        return {
          intent: 'REQUEST_SWAP',
          shiftId: value('shiftId')!,
          targetUserId: value('targetUserId') ?? '',
          targetUserName: heardName,
          reason: value('reason') ?? null,
          confidence,
          summary,
        };
      case 'APPROVE_SWAP':
      case 'DECLINE_SWAP':
        return { intent, swapRequestId: value('swapRequestId')!, confidence, summary };
      case 'APPROVE_JOIN':
      case 'DECLINE_JOIN':
        return { intent, joinRequestId: value('joinRequestId')!, confidence, summary };
      case 'CREATE_SHIFT':
        return {
          intent: 'CREATE_SHIFT',
          roleId: value('roleId')!,
          date: value('date')!,
          start: value('start')!,
          end: value('end')!,
          userId: value('userId') ?? null,
          ...(named ? { targetUserName: heardName } : {}),
          confidence,
          summary,
        };
      case 'EDIT_SHIFT': {
        // The person on the shift: a new one (an id, or a name to look up), taken off (clearAssignee),
        // or — null, with no name — unchanged. Every key is always sent, so a bare null can't mean "off".
        const userId = value('userId') ?? (raw.clearAssignee === true ? null : named ? null : undefined);
        return {
          intent: 'EDIT_SHIFT',
          shiftId: value('shiftId')!,
          roleId: value('roleId'),
          date: value('date'),
          start: value('start'),
          end: value('end'),
          userId,
          ...(named && raw.clearAssignee !== true ? { targetUserName: heardName } : {}),
          confidence,
          summary,
        };
      }
      case 'PUBLISH_ROTA':
        return { intent: 'PUBLISH_ROTA', weekStart: value('weekStart')!, confidence, summary };
      case 'APPLY_ROTA_TEMPLATE':
        return {
          intent: 'APPLY_ROTA_TEMPLATE',
          templateId: value('templateId') ?? null,
          templateName: value('templateName')!,
          weekStart: value('weekStart')!,
          confidence,
          summary,
        };
      case 'POST_ANNOUNCEMENT':
        return { intent: 'POST_ANNOUNCEMENT', content: raw.content as string, confidence, summary };
      case 'POST_SHOUTOUT':
        return {
          intent: 'POST_SHOUTOUT',
          targetUserId: value('targetUserId') ?? '',
          targetUserName: heardName,
          content: raw.content as string,
          confidence,
          summary,
        };
      case 'QUERY_MY_SCHEDULE':
        return { intent: 'QUERY_MY_SCHEDULE', confidence, summary };
      case 'ASSIGN_SECTION':
        return {
          intent: 'ASSIGN_SECTION',
          sectionId: value('sectionId')!,
          staffId: value('staffId') ?? '',
          shiftDate: value('shiftDate')!,
          period: raw.period as 'AM' | 'PM',
          dutyLabel: value('dutyLabel') ?? null,
          ...(named ? { targetUserName: heardName } : {}),
          confidence,
          summary,
        };
    }
  }
  // Not understood, or an answer missing what it needs (parseVoiceIntent turns the latter into a
  // question about exactly what's missing): the caller is told so in plain words. The model's own
  // sentences are kept only when they read like one (see forCaller).
  const said = (intent === 'UNRECOGNIZED' ? forCaller(raw.summary) : null) ?? VOICE_DIDNT_CATCH;
  const why = forCaller(raw.unrecognizedReason);
  // Seen live: the model often writes the same sentence in both. Say it once (the fuller of the
  // two), and the standard hint underneath.
  if (why && repeatsSentence(said, why)) return { intent: 'UNRECOGNIZED', summary: why.length > said.length ? why : said, reason: VOICE_TRY_AGAIN };
  return { intent: 'UNRECOGNIZED', reason: why ?? VOICE_TRY_AGAIN, summary: said };
}

/** A non-empty string, or undefined: null, "", whitespace and anything else count as not given. */
function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * What each action needs before it can be offered, in the order the caller is asked for it. "person"
 * is an id or a name as said (looked up later). CREATE_SHIFT's person is optional (an open shift).
 */
const NEEDS: Record<string, (raw: Record<string, unknown>) => Record<string, boolean>> = {
  MARK_AVAILABILITY: (r) => ({ date: !!text(r.date), availabilityType: r.availabilityType === 'UNAVAILABLE' || r.availabilityType === 'PREFERRED_OFF' }),
  REQUEST_SWAP: (r) => ({ person: !!(text(r.targetUserId) || text(r.targetUserName)), shiftId: !!text(r.shiftId) }),
  APPROVE_SWAP: (r) => ({ swapRequestId: !!text(r.swapRequestId) }),
  DECLINE_SWAP: (r) => ({ swapRequestId: !!text(r.swapRequestId) }),
  APPROVE_JOIN: (r) => ({ joinRequestId: !!text(r.joinRequestId) }),
  DECLINE_JOIN: (r) => ({ joinRequestId: !!text(r.joinRequestId) }),
  CREATE_SHIFT: (r) => ({ date: !!text(r.date), start: !!text(r.start), end: !!text(r.end), roleId: !!text(r.roleId) }),
  EDIT_SHIFT: (r) => ({ shiftId: !!text(r.shiftId) }),
  ASSIGN_SECTION: (r) => ({
    person: !!(text(r.staffId) || text(r.targetUserName)),
    sectionId: !!text(r.sectionId),
    shiftDate: !!text(r.shiftDate),
    period: r.period === 'AM' || r.period === 'PM',
  }),
  PUBLISH_ROTA: (r) => ({ weekStart: !!text(r.weekStart) }),
  APPLY_ROTA_TEMPLATE: (r) => ({ templateName: !!text(r.templateName), weekStart: !!text(r.weekStart) }),
  POST_ANNOUNCEMENT: (r) => ({ content: !!text(r.content) }),
  POST_SHOUTOUT: (r) => ({ person: !!(text(r.targetUserId) || text(r.targetUserName)), content: !!text(r.content) }),
  QUERY_MY_SCHEDULE: () => ({}),
};

/** For a known intent: what its answer lacks ([] when complete). Null for UNRECOGNIZED or anything unknown. */
export function missingFields(raw: Record<string, unknown>): string[] | null {
  const needs = typeof raw.intent === 'string' ? NEEDS[raw.intent] : undefined;
  if (!needs) return null;
  return Object.entries(needs(raw))
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
}

/** How the caller is asked for each missing part, by intent (default: by key). */
const ASK: Record<string, string> = {
  date: 'which day',
  availabilityType: 'are you unavailable, or would you just prefer it off',
  shiftId: 'which shift',
  swapRequestId: 'which one',
  joinRequestId: 'whose request',
  roleId: 'which role',
  start: 'what time does it start',
  end: 'what time does it end',
  sectionId: 'which section',
  shiftDate: 'which day',
  period: 'morning or evening',
  weekStart: 'which week',
  templateName: 'which template',
  content: 'what should it say',
};
const ASK_PERSON: Record<string, string> = { REQUEST_SWAP: 'who should cover it', ASSIGN_SECTION: 'who', POST_SHOUTOUT: 'who is it for' };

/** "a, b, and c" — the questions as one. */
function joinAsks(asks: string[]): string {
  return asks.length < 2 ? (asks[0] ?? '') : `${asks.slice(0, -1).join(', ')}, and ${asks[asks.length - 1]}`;
}

/**
 * A recognised command missing something it needs (seen live: a new shift with no end or role, a
 * section move with no section, day or period): say what was understood and ask for exactly what
 * is missing, instead of "I didn't catch that". The person named is still looked up — nobody by
 * that name is said so; a shared first name is part of the question. Nothing is offered to
 * confirm: the caller adds the missing part and tries again. Null when the answer isn't one.
 */
export function askForMissing(
  raw: Record<string, unknown>,
  ctx: PromptContext,
  caller: { id: string; systemRole: SystemRole },
  transcript: string,
): ParsedIntent | null {
  const missing = missingFields(raw);
  const intent = raw.intent as string;
  if (!missing?.length) return null;
  if (!allowedIntentsFor(caller.systemRole).includes(intent)) return clarify(VOICE_ROLE_REFUSAL, VOICE_ROLE_REFUSAL);

  // Who it's about, looked up exactly as for a complete answer.
  const personKey = intent === 'ASSIGN_SECTION' ? 'staffId' : intent === 'CREATE_SHIFT' || intent === 'EDIT_SHIFT' ? 'userId' : intent === 'REQUEST_SWAP' || intent === 'POST_SHOUTOUT' ? 'targetUserId' : null;
  const heard = text(raw.targetUserName) ?? '';
  const modelId = personKey ? (text(raw[personKey]) ?? null) : null;
  let person: string | null = null;
  const asks: string[] = [];
  let personQuestion: PersonQuestion | undefined;
  if (personKey && (heard || modelId)) {
    const found = resolvePerson(heard, modelId, ctx.staffDirectory, transcript, caller.id);
    if (found.kind === 'missing') return missingPerson(found, caller, transcript, []);
    if (found.kind === 'one') person = found.person.fullName;
    if (found.kind === 'ambiguous') {
      person = found.heard;
      personQuestion = { heard: found.heard, status: 'ambiguous' };
      asks.push(found.people.length <= MAX_PEOPLE_CHOICES ? `which ${found.heard} (${found.people.map((p) => p.fullName).join(' or ')})` : `which ${found.heard} (say their full name)`);
    }
    if (found.kind === 'unknown' && !missing.includes('person') && intent !== 'CREATE_SHIFT' && intent !== 'EDIT_SHIFT') asks.push(ASK_PERSON[intent] ?? 'who');
  }
  for (const key of missing) asks.push(key === 'person' ? (ASK_PERSON[intent] ?? 'who') : (ASK[key] ?? `which ${key}`));

  const day = (key: string) => (text(raw[key]) ? dayLabel(raw[key] as string) : null);
  const role = text(raw.roleId) ? (ctx.roles ?? []).find((r) => r.id === raw.roleId)?.name : undefined;
  const section = text(raw.sectionId) ? (ctx.floorSections ?? []).find((s) => s.id === raw.sectionId)?.label : undefined;
  const bit = (cond: unknown, s: string) => (cond ? s : '');
  const what: Record<string, string> = {
    MARK_AVAILABILITY: `time off for you${bit(day('date'), ` on ${day('date')}`)}`,
    REQUEST_SWAP: `a swap request${bit(person, ` for ${person} to cover`)}`,
    APPROVE_SWAP: 'a swap request to approve',
    DECLINE_SWAP: 'a swap request to decline',
    APPROVE_JOIN: 'a join request to approve',
    DECLINE_JOIN: 'a join request to decline',
    CREATE_SHIFT: `a new ${bit(role, `${role} `)}shift${bit(person, ` for ${person}`)}${bit(day('date'), ` on ${day('date')}`)}${bit(text(raw.start), ` from ${raw.start}`)}${bit(text(raw.end), ` until ${raw.end}`)}`,
    EDIT_SHIFT: 'a shift change',
    ASSIGN_SECTION: `a section move${bit(person, ` for ${person}`)}${bit(section, ` to the ${section}`)}${bit(day('shiftDate'), ` on ${day('shiftDate')}`)}${bit(raw.period === 'AM' || raw.period === 'PM', `, ${raw.period}`)}`,
    PUBLISH_ROTA: 'the rota to publish',
    APPLY_ROTA_TEMPLATE: `a rota template${bit(text(raw.templateName), ` (“${raw.templateName}”)`)}${bit(day('weekStart'), ` for the week of ${day('weekStart')}`)}`,
    POST_ANNOUNCEMENT: 'an announcement',
    POST_SHOUTOUT: `a shout-out${bit(person, ` for ${person}`)}${bit(text(raw.content), ` saying “${raw.content}”`)}`,
  };
  return {
    intent: 'UNRECOGNIZED',
    summary: `I've got ${what[intent] ?? 'that'} — ${joinAsks(asks)}?`,
    reason: 'Add it to what I heard and tap Try again, or say the whole thing again.',
    incomplete: { intent, missing },
    ...(personQuestion ? { person: personQuestion } : {}),
  };
}
