import { GoogleGenAI, ApiError, ThinkingLevel } from '@google/genai';
import type { SystemRole } from '@prisma/client';
import { allowedIntentsFor, intentSchemaFor, type ChoosableIntent, type ParsedIntent, type ReadingDetails, type Unrecognized } from './intentSchema.js';
import { MAX_PEOPLE_CHOICES, nameFits, normalizeName, othersNamed, resolvePerson, type PersonResolution, type StaffEntry } from './people.js';
import { mentionedIn, periodSaid, type Term } from './vocabulary.js';
import { repeatsSentence, VOICE_ROLE_REFUSAL } from '../../../shared/voiceIntents.js';
import { buildSystemPrompt } from './prompts.js';
import { reportIfModelUnavailable, voiceClientOptions, voiceModel } from './model.js';
import { getRotaPublishPreview, publishFingerprint } from '../lib/actions/rotaActions.js';
import { announcementAudience } from '../lib/actions/communicationActions.js';
import { prisma } from '../lib/prisma.js';
import { bestMatch } from '../lib/textSimilarity.js';
import { AiBudgetExceededError, MAX_OUTPUT_TOKENS, textInputEstimate, withAiBudget } from '../lib/aiBudget.js';
import { billedOutputTokens } from '../parsing/visionProvider.js';
import { findOverlappingShift, shiftInstants } from '../lib/shiftRules.js';
import { formatVenueTime } from '../lib/venueTime.js';
import { buildContext, venueSpellingHint, type VenueContext } from './context.js';
import { dayLabel, missingPerson, NOT_FOUND, normalizeToolCall, resolveToolCall, type Reading, type ToolCall } from './tools.js';

export { buildContext, dayLabel };
export type { VenueContext };

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
 * Below this, a real (non-UNRECOGNIZED) tool is coerced to an UNRECOGNIZED-shaped response before
 * it reaches the client — the model attempted a match but wasn't confident enough. The ORIGINAL
 * attempted tool/confidence is still what gets logged (interactionLog.ts).
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/** What the model picked, uncoerced: the tool (or UNRECOGNIZED) and its confidence. Always logged as-is. */
export interface AttemptedReading {
  intent: string;
  confidence: number;
}

/**
 * Parses a transcript into a role-scoped intent. Never mutates anything —
 * this is the "propose" half of the confirm-before-execute boundary. The
 * caller's role restricts BOTH the Gemini response schema (the model
 * structurally cannot emit an out-of-scope tool) and the prompt text
 * (defense-in-depth) — but /execute must still re-check role independently,
 * since this function's output is not itself a trust boundary.
 */
export interface VoiceIntentResolution {
  /** What the client should see/act on — coerced to UNRECOGNIZED if below CONFIDENCE_THRESHOLD. */
  response: ParsedIntent;
  /** What the model actually returned, uncoerced — always logged as-is. */
  attempted: AttemptedReading;
  /** What the model reported for hasAdditionalRequest, uncoerced — always logged as-is (see interactionLog.ts), regardless of what outcome/response the caller ends up seeing. */
  hasAdditionalRequest: boolean;
}

type Caller = { id: string; systemRole: SystemRole; fullName: string; locationId: string };

export async function parseVoiceIntent(transcript: string, user: Caller): Promise<VoiceIntentResolution> {
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
  // The model gets the date and the bounded spelling hint, nothing else from the venue.
  const systemPrompt = buildSystemPrompt(user.systemRole, { today: context.today, hint: await venueSpellingHint(user.locationId) });
  const schema = intentSchemaFor(user.systemRole);

  let raw: Record<string, unknown>;
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
    raw = JSON.parse(response.text ?? '{}') as Record<string, unknown>;
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

  try {
    return await resolveModelAnswer(raw, context, user, transcript);
  } catch (err) {
    throw new VoiceIntentError('Unexpected error while resolving the voice command.', err);
  }
}

/** Everything after the model call: the model's answer → what the caller sees. Exported for tests. */
export async function resolveModelAnswer(raw: Record<string, unknown>, ctx: VenueContext, user: Caller, transcript: string): Promise<VoiceIntentResolution> {
  const call = normalizeToolCall(raw);
  // Computed independently of confidence/the gate below.
  const hasAdditionalRequest = normalizeHasAdditionalRequest(raw);
  if (!call) return { response: unrecognizedFrom(raw), attempted: { intent: 'UNRECOGNIZED', confidence: 0 }, hasAdditionalRequest };
  const attempted = { intent: call.tool, confidence: call.confidence };
  if (call.tool !== 'DECLINED' && !allowedIntentsFor(user.systemRole).includes(call.tool)) {
    // The app recognises this exact reason and shows its role-refusal message (shared contract).
    return { response: clarify(VOICE_ROLE_REFUSAL, VOICE_ROLE_REFUSAL), attempted, hasAdditionalRequest };
  }
  const full = await resolveCall(call, ctx, user, transcript);
  if (call.confidence >= CONFIDENCE_THRESHOLD) return { response: full, attempted, hasAdditionalRequest };

  // Below the gate. A person the server couldn't pin down is asked about directly: often that is
  // exactly why the model was unsure. Otherwise the model's two or three readings that pass every
  // check are offered as choices; failing that, "I'm not sure I got that right".
  if (full.intent === 'UNRECOGNIZED' && full.person) return { response: full, attempted, hasAdditionalRequest };
  const others: ParsedIntent[] = [];
  for (const alt of normalizeAlternatives(raw)) {
    if (!allowedIntentsFor(user.systemRole).includes(alt.tool)) continue;
    others.push(await resolveCall(alt, ctx, user, transcript));
  }
  const options = offerable([full, ...others]);
  const response: ParsedIntent = options.length >= 2 ? { intent: 'UNRECOGNIZED', summary: WHICH_DID_YOU_MEAN, reason: PICK_ONE, options } : lowConfidenceResponse(call.summary);
  return { response, attempted, hasAdditionalRequest };
}

/** One tool call, resolved in the caller's venue and checked like any confirmable answer. */
async function resolveCall(call: ToolCall, ctx: VenueContext, user: Caller, transcript: string): Promise<ParsedIntent> {
  const resolved = await resolveToolCall(call, ctx, user, transcript);
  if (resolved.kind === 'final') return resolved.intent;
  const timezone = ctx.timezone;
  const check = async (r: Reading): Promise<ParsedIntent> => {
    let checked: ParsedIntent = r;
    if (checked.intent === 'PUBLISH_ROTA') checked = await refinePublishRotaResponse(checked, user.locationId);
    else if (checked.intent === 'APPLY_ROTA_TEMPLATE') checked = await refineApplyRotaTemplateResponse(checked, ctx.rotaTemplates ?? []);
    else if (checked.intent === 'POST_ANNOUNCEMENT') checked = await refineAnnouncementResponse(checked, user);
    return checkAgainstContext(checked, ctx, user, timezone, transcript);
  };
  if (resolved.kind === 'reading') return check(resolved.reading);
  // Several readings: each is checked on its own; those that pass are the choices.
  const results = await Promise.all(resolved.readings.map(check));
  const options = offerable(results).map((o) => ({ ...o, summary: personSummary(o) }) as ChoosableIntent);
  if (options.length === 1 && results.length === 1) return options[0]!;
  if (options.length >= 1) return { intent: 'UNRECOGNIZED', summary: resolved.summary, reason: PICK_ONE, options };
  return results[0]!;
}

/** The confirmable actions among these answers, without duplicates, at most MAX_VOICE_OPTIONS. */
function offerable(answers: ParsedIntent[]): ChoosableIntent[] {
  const options: ChoosableIntent[] = [];
  const seen = new Set<string>();
  for (const a of answers) {
    if (options.length === MAX_VOICE_OPTIONS) break;
    if (!isAction(a)) continue;
    const key = JSON.stringify({ ...a, confidence: 0, summary: '', details: undefined });
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(a);
  }
  return options;
}

function isAction(a: ParsedIntent): a is ChoosableIntent {
  return a.intent !== 'UNRECOGNIZED' && a.intent !== 'DECLINED' && !('answer' in a);
}

/**
 * A missing/non-boolean value fails CLOSED to false — an absent flag must
 * never fabricate a "there's more" prompt the model didn't actually make.
 */
export function normalizeHasAdditionalRequest(raw: Record<string, unknown>): boolean {
  return typeof raw.hasAdditionalRequest === 'boolean' ? raw.hasAdditionalRequest : false;
}

/**
 * PUBLISH_ROTA's confirm preview states exactly what the publish changes: the shifts that are new
 * or edited since the week was last published, and the people it notifies — recomputed from the
 * same queries `publishRota` uses, never the model's arithmetic. A week with nothing to publish,
 * or nothing changed since its last publish, is said so instead of offering a Confirm.
 */
export async function refinePublishRotaResponse(response: Extract<ParsedIntent, { intent: 'PUBLISH_ROTA' }>, locationId: string): Promise<ParsedIntent> {
  const weekStart = new Date(`${response.weekStart}T00:00:00.000Z`);
  if (Number.isNaN(weekStart.getTime())) {
    return { intent: 'UNRECOGNIZED', reason: WHICH_WEEK_HINT, summary: 'Which week should I publish?' };
  }
  const { shiftCount, staffCount, shiftsChanging } = await getRotaPublishPreview(locationId, weekStart);
  const week = dayLabel(response.weekStart);
  if (shiftCount === 0) {
    return { intent: 'UNRECOGNIZED', reason: `No shifts exist for the week of ${week} yet.`, summary: `There are no shifts scheduled for the week of ${week} yet — nothing to publish.` };
  }
  if (shiftsChanging === 0) {
    return { intent: 'UNRECOGNIZED', reason: 'Change a shift first, then publish again.', summary: `The week of ${week} is already published, with no changes since.` };
  }
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const summary = `This will publish ${s(shiftsChanging, 'new or changed shift', 'new or changed shifts')} for the week of ${week} and notify ${s(staffCount, 'person', 'people')} — confirm?`;
  const fingerprint = await publishFingerprint(prisma, locationId, weekStart);
  return { ...response, counts: { shiftsChanging, peopleNotified: staffCount }, fingerprint, summary };
}

/**
 * An announcement's preview says how many people it notifies (everyone active at the venue but the
 * author), counted here, never by the app; the fingerprint lets Confirm check nobody joined or left.
 */
export async function refineAnnouncementResponse(
  response: Extract<ParsedIntent, { intent: 'POST_ANNOUNCEMENT' }>,
  caller: { id: string; locationId: string },
): Promise<ParsedIntent> {
  const { recipients, fingerprint } = await announcementAudience(prisma, caller.locationId, caller.id);
  return { ...response, recipients, fingerprint };
}

const TEMPLATE_MATCH_THRESHOLD = 0.6;
const TEMPLATE_MATCH_MARGIN = 0.1;

/**
 * APPLY_ROTA_TEMPLATE: the template name as heard, scored against the venue's real saved
 * templates. Resolves only when the best match clears an absolute floor and a margin over the
 * runner-up; otherwise asks rather than applying the closest guess.
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
    // A model-supplied id (a hand-built answer) must agree with the name.
    (response.templateId === null || response.templateId === best.id);

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
 * no "intent", "supported command" or other internals.
 */
export const VOICE_DIDNT_CATCH = "I didn't catch what you'd like to do.";
export const VOICE_TRY_AGAIN = 'Try again with who, what and when — for example "Mark me unavailable on Friday".';
const WHICH_WEEK_HINT = 'Say the week, for example "this week" or "next week".';
/** Model text that reads like a log line, not a sentence for the caller. */
const JARGON = /\bintents?\b|\btools?\b|supported command|\bschema\b|\bjson\b|\bunrecognized\b|\bids?\b|could not (confidently )?(match|resolve|determine)/i;

/** The model's own sentence for the caller, if it wrote one that reads like one. */
function forCaller(text: unknown): string | null {
  return typeof text === 'string' && text.trim() && !JARGON.test(text) ? text.trim() : null;
}

/** The model said UNRECOGNIZED (or something unusable): its own words when they read like a sentence, else the standard ones. */
function unrecognizedFrom(raw: Record<string, unknown>): Unrecognized {
  const said = (raw.tool === 'UNRECOGNIZED' ? forCaller(raw.summary) : null) ?? VOICE_DIDNT_CATCH;
  const why = forCaller(raw.unrecognizedReason);
  // Seen live: the model often writes the same sentence in both. Say it once, and the standard hint.
  if (why && repeatsSentence(said, why)) return { intent: 'UNRECOGNIZED', summary: why.length > said.length ? why : said, reason: VOICE_TRY_AGAIN };
  return { intent: 'UNRECOGNIZED', reason: why ?? VOICE_TRY_AGAIN, summary: said };
}

/** Below the confidence gate: say what it sounded like, and how to fix it. */
function lowConfidenceResponse(summary: string): ParsedIntent {
  const heard = summary.trim().replace(/[.!?]+$/, '');
  return {
    intent: 'UNRECOGNIZED',
    reason: heard ? `It sounded like "${heard}", but I'd rather check than guess. Say it again, or fix what I heard and try again.` : 'Say it again, or fix what I heard and try again.',
    summary: "I'm not sure I got that right.",
  };
}

/** The model's other readings (`alternatives`), narrowed like the main one. */
function normalizeAlternatives(raw: Record<string, unknown>): ToolCall[] {
  const list = raw.alternatives;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, MAX_VOICE_OPTIONS - 1)
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .map((a) => normalizeToolCall(a))
    .filter((a): a is ToolCall => a !== null && a.tool !== 'DECLINED');
}

function clarify(reason: string, summary: string): Unrecognized {
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
        : response.intent === 'REQUEST_TIME_OFF' && response.startDate === response.endDate
          ? response.startDate
          : undefined;
  if (!date) return null;
  const actual = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  if (Number.isNaN(actual) || actual === said[0]) return null;
  return clarify(`Say the day again, or fix what I heard and try again.`, `You said ${WEEKDAY_NAMES[said[0]!]}, but that date is a ${WEEKDAY_NAMES[actual]}. Which day did you mean?`);
}

const PAST_DATE = clarify('Pick a day from today onwards.', 'That day has already passed. Which day did you mean?');

/** Readings that are always about the caller's own days: they carry no person. */
const SELF_ONLY = new Set<string>(['MARK_AVAILABILITY', 'REQUEST_TIME_OFF']);

/**
 * "Give Omar next Friday off": time off and availability are always the caller's own, so a reading
 * of one whose words name someone else would book the caller's days, not that person's. It is
 * asked, never offered. Null when the words name nobody else.
 */
export function selfOnlyNamesOther(r: ParsedIntent, transcript: string, staff: StaffEntry[], callerId: string): Unrecognized | null {
  if (!SELF_ONLY.has(r.intent) || !transcript.trim()) return null;
  const named = othersNamed(staff, transcript, callerId);
  if (!named.length) return null;
  const who = named[0]!.fullName.split(/\s+/)[0]!;
  return clarify(
    "To change someone else's days, use the rota. By voice, time off and availability are for your own days only.",
    `That would book your own days off, not ${who}'s.`,
  );
}

/**
 * Propose-time backstop: the confirm sheet must never offer something /execute would refuse, or
 * that the caller didn't say. Everything here is deterministic and checked against the caller's
 * own venue (`buildContext`):
 *  - an intent outside the caller's role;
 *  - any id (person, shift, section, role, request) not in the caller's venue;
 *  - a date that has already passed;
 *  - a shift that overlaps the person's existing shift.
 * /execute still re-checks everything on its own.
 */
export async function checkAgainstContext(
  response: ParsedIntent,
  ctx: VenueContext,
  caller: { id: string; systemRole: SystemRole; locationId: string },
  timezone: string,
  transcript = '',
): Promise<ParsedIntent> {
  if (!isAction(response)) return response;
  if (!allowedIntentsFor(caller.systemRole).includes(response.intent)) {
    return clarify(VOICE_ROLE_REFUSAL, VOICE_ROLE_REFUSAL);
  }
  const mismatch = weekdayMismatch(transcript, response);
  if (mismatch) return mismatch;
  const notYours = selfOnlyNamesOther(response, transcript, ctx.staffDirectory, caller.id);
  if (notYours) return notYours;
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
  }
  const term = await askWhichTerm(response, ctx, caller, timezone, transcript);
  if (term) return term;
  const checked = await checkIds(response, ctx, caller, timezone);
  return isAction(checked) ? withDetails(checked, ctx) : checked;
}

/**
 * The section, role or service period the caller said, against the one resolved: the venue's own
 * sections/roles named in the transcript ("the bar" → Main Bar and Pool Bar) must include the pick
 * and be only that one, and "closing"/"dinner" must not be a morning. Otherwise one checked
 * reading per candidate is put to the caller. Null when the words agree with the pick.
 */
async function askWhichTerm(r: Reading, ctx: VenueContext, caller: { id: string; locationId: string }, timezone: string, transcript: string): Promise<ParsedIntent | null> {
  if (!transcript.trim()) return null;
  const readings: Reading[] = [];
  let summary = WHICH_DID_YOU_MEAN;
  if (r.intent === 'ASSIGN_SECTION' || r.intent === 'CREATE_SHIFT' || (r.intent === 'EDIT_SHIFT' && r.roleId)) {
    const isSection = r.intent === 'ASSIGN_SECTION';
    const items: Term[] = isSection ? (ctx.floorSections ?? []) : (ctx.roles ?? []).filter((x) => x.isActive !== false).map((x) => ({ id: x.id, label: x.name }));
    const current = isSection ? r.sectionId : (r as { roleId: string }).roleId;
    const named = mentionedIn(transcript, items);
    if (named.length && !(named.length === 1 && named[0]!.id === current)) {
      const ids = [...new Set([...named.map((i) => i.id), ...(items.some((i) => i.id === current) ? [current] : [])])].slice(0, MAX_VOICE_OPTIONS + 1);
      for (const id of ids) readings.push((isSection ? { ...r, sectionId: id } : { ...r, roleId: id }) as Reading);
      summary = isSection ? 'Which section did you mean?' : 'Which role did you mean?';
    }
  }
  if (!readings.length && r.intent === 'ASSIGN_SECTION') {
    const said = periodSaid(transcript);
    if (said && said !== r.period) {
      readings.push({ ...r, period: said }, r);
      summary = said === 'PM' ? 'You said an evening service — morning or evening?' : 'You said a daytime service — morning or evening?';
    }
  }
  if (!readings.length) return null;
  const options: ChoosableIntent[] = [];
  for (const reading of readings) {
    const checked = await checkIds(reading, ctx, caller, timezone);
    if (!isAction(checked)) continue;
    const described = withDetails(checked, ctx);
    options.push({ ...described, summary: personSummary(described) });
  }
  if (options.length < 2) return options.length ? null : NOT_FOUND(r.intent === 'ASSIGN_SECTION' ? 'section' : 'role');
  return { intent: 'UNRECOGNIZED', summary, reason: PICK_ONE, options };
}

/** An overlap with the person's existing shift, as a question; null when clear. */
async function overlapQuestion(userId: string, date: string, start: string, end: string, caller: { locationId: string }, timezone: string, excludeShiftId?: string) {
  const { startTime, endTime } = shiftInstants(date, start, end, timezone);
  const clash = await findOverlappingShift({ userId, locationId: caller.locationId, startTime, endTime, excludeShiftId });
  if (!clash) return null;
  const when = `${formatVenueTime(clash.startTime, timezone)}–${formatVenueTime(clash.endTime, timezone)}`;
  return clarify(`That person already works ${when} then.`, `They already have a shift ${when} that overlaps. Pick another time or person.`);
}

/** The id, date and overlap checks behind `checkAgainstContext`, for a reading whose person is settled. */
async function checkIds(response: Reading, ctx: VenueContext, caller: { id: string; locationId: string }, timezone: string): Promise<ParsedIntent> {
  const staff = new Set(ctx.staffDirectory.map((s) => s.id));
  const isPast = (date: string | undefined) => date !== undefined && date < ctx.today;
  const activeRole = (id: string) => (ctx.roles ?? []).some((r) => r.id === id && r.isActive !== false);
  switch (response.intent) {
    case 'MARK_AVAILABILITY':
      return isPast(response.date) ? PAST_DATE : response;
    case 'REQUEST_TIME_OFF':
      return isPast(response.startDate) ? PAST_DATE : response;
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
      if (!activeRole(response.roleId)) return NOT_FOUND('role');
      if (response.userId !== null && !staff.has(response.userId)) return NOT_FOUND('person');
      if (isPast(response.date)) return PAST_DATE;
      if (response.userId !== null) {
        for (const part of [response, ...(response.second ? [response.second] : [])]) {
          const clash = await overlapQuestion(response.userId, response.date, part.start, part.end, caller, timezone);
          if (clash) return clash;
        }
      }
      return response;
    }
    case 'EDIT_SHIFT': {
      const shift = (ctx.weekShifts ?? []).find((s) => s.id === response.shiftId);
      if (!shift) return NOT_FOUND('shift');
      if (response.roleId !== undefined && !activeRole(response.roleId)) return NOT_FOUND('role');
      if (typeof response.userId === 'string' && !staff.has(response.userId)) return NOT_FOUND('person');
      if (isPast(shift.date) || isPast(response.date)) return PAST_DATE;
      const who = response.userId === undefined ? shift.assigneeId : response.userId;
      if (who) {
        const clash = await overlapQuestion(who, response.date ?? shift.date, response.start ?? shift.start, response.end ?? shift.end, caller, timezone, shift.id);
        if (clash) return clash;
      }
      return response;
    }
    case 'CANCEL_SHIFT': {
      const shift = (ctx.weekShifts ?? []).find((s) => s.id === response.shiftId);
      if (!shift) return NOT_FOUND('shift');
      return isPast(shift.date) ? clarify('Only shifts from today onwards can be cancelled.', 'That shift has already happened.') : response;
    }
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
 * The person a reading names, if it names one: the name as said and any id already settled.
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

/** Names for the confirm sheet's preview, from the caller's own venue lists only (never a phone number). */
function describeReading(r: Reading, ctx: VenueContext): ReadingDetails | undefined {
  const nameOf = (id: string) => ctx.staffDirectory.find((s) => s.id === id)?.fullName ?? null;
  const personRole = (id: string | null | undefined) => {
    const role = id ? ctx.staffDirectory.find((s) => s.id === id)?.role : null;
    return role ? { personRole: role } : {};
  };
  const roleOf = (id: string) => (ctx.roles ?? []).find((x) => x.id === id)?.name;
  switch (r.intent) {
    case 'POST_SHOUTOUT':
      return { person: nameOf(r.targetUserId), ...personRole(r.targetUserId) };
    case 'REQUEST_SWAP': {
      const s = ctx.callerShifts.find((x) => x.id === r.shiftId);
      return { person: nameOf(r.targetUserId), ...personRole(r.targetUserId), ...(s ? { shift: { date: s.date, start: s.startTime, end: s.endTime } } : {}) };
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
      return { person: r.userId ? nameOf(r.userId) : null, ...personRole(r.userId), role: roleOf(r.roleId) };
    case 'EDIT_SHIFT': {
      const s = (ctx.weekShifts ?? []).find((x) => x.id === r.shiftId);
      return {
        ...(r.userId !== undefined ? { person: r.userId ? nameOf(r.userId) : null, ...personRole(r.userId) } : {}),
        ...(r.roleId ? { role: roleOf(r.roleId) } : {}),
        ...(s ? { shift: { date: s.date, start: s.start, end: s.end, role: s.roleName, person: s.assigneeName } } : {}),
      };
    }
    case 'CANCEL_SHIFT': {
      const s = (ctx.weekShifts ?? []).find((x) => x.id === r.shiftId);
      if (!s) return undefined;
      return { person: s.assigneeName, personRole: s.assigneeId ? (ctx.staffDirectory.find((x) => x.id === s.assigneeId)?.role ?? null) : null, date: s.date, start: s.start, end: s.end, role: s.roleName };
    }
    case 'ASSIGN_SECTION':
      return { person: nameOf(r.staffId), ...personRole(r.staffId), section: (ctx.floorSections ?? []).find((x) => x.id === r.sectionId)?.label };
    default:
      return undefined;
  }
}

/** The reading with its preview names and the server's own sentence. */
function withDetails(r: Reading, ctx: VenueContext): Reading {
  const details = describeReading(r, ctx);
  const described = details ? { ...r, details } : r;
  return { ...described, summary: serverSummary(described) ?? r.summary };
}

/** The sentence for the confirm sheet, written by the server from the resolved reading; null keeps the existing one. */
function serverSummary(r: Reading): string | null {
  const d = r.details ?? {};
  switch (r.intent) {
    case 'CANCEL_SHIFT':
      return `Cancel ${d.person ? `${d.person}'s` : 'the open'} ${d.role ? `${d.role} ` : ''}shift on ${dayLabel(d.date ?? '')}, ${d.start}–${d.end}.`;
    case 'REQUEST_TIME_OFF':
      return r.startDate === r.endDate ? `Ask for ${dayLabel(r.startDate)} off.` : `Ask for ${dayLabel(r.startDate)} to ${dayLabel(r.endDate)} off.`;
    case 'CREATE_SHIFT':
      return r.second
        ? `Create a split ${d.role ? `${d.role} ` : ''}shift for ${d.person ?? 'nobody yet (open)'}, ${dayLabel(r.date)} ${r.start}–${r.end} and ${r.second.start}–${r.second.end}.`
        : `Create a ${d.role ? `${d.role} ` : ''}shift for ${d.person ?? 'nobody yet (open)'}, ${dayLabel(r.date)} ${r.start}–${r.end}.`;
    default:
      return null;
  }
}

/** A choice's own sentence: the model's summary named whoever it picked, not this person. */
function personSummary(r: Reading): string {
  const d = r.details ?? {};
  const name = d.person ?? 'them';
  switch (r.intent) {
    case 'POST_SHOUTOUT':
      return `Give ${name} a shout-out.`;
    case 'REQUEST_SWAP':
      return d.shift ? `Ask ${name} to cover your ${dayLabel(d.shift.date)} shift.` : `Ask ${name} to cover your shift.`;
    case 'CREATE_SHIFT':
      return serverSummary(r)!;
    case 'EDIT_SHIFT': {
      const what = d.shift ? `the ${dayLabel(d.shift.date)} ${d.shift.start}–${d.shift.end} shift${d.shift.person ? ` (${d.shift.person})` : ''}` : 'that shift';
      if (r.userId) return `Give ${what} to ${name}.`;
      if (r.userId === null) return `Take the person off ${what}.`;
      return `Change ${what}${r.start || r.end ? ` to ${r.start ?? d.shift?.start}–${r.end ?? d.shift?.end}` : ''}${r.date ? ` on ${dayLabel(r.date)}` : ''}${r.roleId && d.role ? ` as ${d.role}` : ''}.`;
    }
    case 'CANCEL_SHIFT':
      return serverSummary(r)!;
    case 'ASSIGN_SECTION':
      return `Put ${name} on ${d.section ?? 'that section'}, ${dayLabel(r.shiftDate)} ${r.period}.`;
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      return `${r.intent === 'APPROVE_SWAP' ? 'Approve' : 'Decline'} ${name}'s swap${d.shift ? ` for ${dayLabel(d.shift.date)} ${d.shift.start}–${d.shift.end}` : ''}${d.cover ? ` (${d.cover} to cover)` : ''}.`;
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      return `${r.intent === 'APPROVE_JOIN' ? 'Approve' : 'Decline'} ${name}'s request to join.`;
    default:
      return r.summary;
  }
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
  ctx: VenueContext,
  caller: { id: string; systemRole: SystemRole; locationId: string },
  timezone: string,
  transcript: string,
): Promise<ParsedIntent> {
  const candidates = found.kind === 'ambiguous' ? found.people : found.near;
  const options: ChoosableIntent[] = [];
  if (candidates.length <= MAX_PEOPLE_CHOICES) {
    for (const person of candidates) {
      const checked = await checkIds(withPerson(reading, person), ctx, caller, timezone);
      if (!isAction(checked)) continue;
      const described = withDetails(checked, ctx);
      options.push({ ...described, summary: personSummary(described) });
    }
  }
  const choices = options.length ? { options } : {};

  if (found.kind === 'ambiguous') {
    const heard = found.heard;
    const sameName = candidates.every((p) => normalizeName(heard).split(' ').every((w) => normalizeName(p.fullName).split(' ').includes(w)));
    const summary = sameName ? `Which ${heard} did you mean?` : 'Who did you mean?';
    const reason =
      candidates.length > MAX_PEOPLE_CHOICES ? `${candidates.length} people on your team are called ${heard}. Say their full name and try again.` : options.length ? PICK_ONE : 'Say their full name and try again.';
    return { intent: 'UNRECOGNIZED', summary, reason, person: { heard, status: 'ambiguous' }, ...choices };
  }

  // Nobody sounds like the name said: the whole team, each as a complete checked reading, to pick from.
  const team: ChoosableIntent[] = [];
  if (!candidates.length) {
    for (const person of [...ctx.staffDirectory].sort((a, b) => a.fullName.localeCompare(b.fullName)).slice(0, MAX_TEAM_PICKS)) {
      const checked = await checkIds(withPerson(reading, person), ctx, caller, timezone);
      if (!isAction(checked)) continue;
      const described = withDetails(checked, ctx);
      team.push({ ...described, summary: personSummary(described) });
    }
  }
  const result = missingPerson(found, caller, transcript, options);
  return team.length ? { ...result, team } : result;
}

/** At most this many teammates in the "pick from your team" list. */
export const MAX_TEAM_PICKS = 80;

