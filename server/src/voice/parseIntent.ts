import { GoogleGenAI, ApiError } from '@google/genai';
import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { intentSchemaFor, type ParsedIntent } from './intentSchema.js';
import { buildSystemPrompt, type PromptContext } from './prompts.js';
import { formatVenueTime, venueToday, venueTimezoneFor } from '../lib/venueTime.js';
import { voiceModel } from './model.js';

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
    if (attempted.intent === 'UNRECOGNIZED' || attempted.confidence >= CONFIDENCE_THRESHOLD) {
      return { response: attempted, attempted };
    }
    return {
      response: { intent: 'UNRECOGNIZED', reason: `I understood this as "${attempted.summary}" but wasn't confident enough to act on it without you rephrasing.`, summary: 'Could not confidently resolve this command.' },
      attempted,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      throw new VoiceIntentError(`Intent parsing failed (${err.status ?? 'unknown'}): ${err.message}`, err);
    }
    if (err instanceof VoiceIntentError) throw err;
    throw new VoiceIntentError('Unexpected error while parsing the voice command.', err);
  }
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
