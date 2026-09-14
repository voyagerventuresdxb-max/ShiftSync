import { GoogleGenAI, ApiError } from '@google/genai';
import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { intentSchemaFor, type ParsedIntent } from './intentSchema.js';
import { buildSystemPrompt, type PromptContext } from './prompts.js';
import { formatVenueTime, venueToday, venueTimezoneFor } from '../lib/venueTime.js';
import { voiceModel } from './model.js';
import { getRotaPublishPreview } from '../lib/actions/rotaActions.js';
import { bestMatch } from '../lib/textSimilarity.js';

export class VoiceIntentError extends Error {
  /** The underlying error (e.g. a Gemini ApiError) that caused this, if any. */
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceIntentError';
    this.cause = cause;
    // Preserve the original stack so the server log shows the real failure
    // point instead of only the wrapper's message.
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

let client: GoogleGenAI | null = null;

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
      include: { requestedBy: { select: { fullName: true } }, shift: { select: { date: true, startTime: true, endTime: true } } },
      take: 20,
    });
    ctx.pendingSwapRequests = pendingSwaps.map((r) => ({
      id: r.id,
      requesterName: r.requestedBy.fullName,
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
  if (!process.env.GEMINI_API_KEY) {
    throw new VoiceIntentError('GEMINI_API_KEY is not configured on the server — voice intent parsing is unavailable.');
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const context = await buildContext(user);
  const systemPrompt = buildSystemPrompt(user.systemRole, context);
  const schema = intentSchemaFor(user.systemRole);

  try {
    const response = await client.models.generateContent({
      model: voiceModel(),
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });
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

    return { response: clientResponse, attempted, hasAdditionalRequest };
  } catch (err) {
    if (err instanceof ApiError) {
      throw new VoiceIntentError(`Intent parsing failed (${err.status ?? 'unknown'}): ${err.message}`, err);
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

/**
 * Narrows Gemini's loosely-typed JSON object into the real ParsedIntent
 * union, defaulting to UNRECOGNIZED on any shape mismatch rather than
 * trusting an unexpected field combination. The response schema already
 * makes most of these mismatches structurally impossible, but this is the
 * defense-in-depth layer that never trusts the raw JSON at face value.
 */
function normalizeParsedIntent(raw: Record<string, unknown>): ParsedIntent {
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
