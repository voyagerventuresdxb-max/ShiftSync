import { GoogleGenAI, ApiError } from '@google/genai';
import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { intentSchemaFor, type ParsedIntent } from './intentSchema.js';
import { buildSystemPrompt, type PromptContext } from './prompts.js';

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

async function buildContext(user: { id: string; systemRole: SystemRole; fullName: string; locationId: string }): Promise<PromptContext> {
  const today = new Date().toISOString().slice(0, 10);
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
  ctx.callerShifts = shifts.map((s) => ({
    id: s.id,
    date: s.date.toISOString().slice(0, 10),
    startTime: s.startTime.toISOString().slice(11, 16),
    endTime: s.endTime.toISOString().slice(11, 16),
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
      shiftLabel: `${r.shift.date.toISOString().slice(0, 10)} ${r.shift.startTime.toISOString().slice(11, 16)}-${r.shift.endTime.toISOString().slice(11, 16)}`,
    }));

    const pendingJoins = await prisma.joinRequest.findMany({
      where: { locationId: user.locationId, status: 'PENDING' },
      take: 20,
    });
    ctx.pendingJoinRequests = pendingJoins.map((r) => ({ id: r.id, fullName: r.fullName, phone: r.phone }));
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
export async function parseVoiceIntent(
  transcript: string,
  user: { id: string; systemRole: SystemRole; fullName: string; locationId: string },
): Promise<ParsedIntent> {
  if (!process.env.GEMINI_API_KEY) {
    throw new VoiceIntentError('GEMINI_API_KEY is not configured on the server — voice intent parsing is unavailable.');
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const context = await buildContext(user);
  const systemPrompt = buildSystemPrompt(user.systemRole, context);
  const schema = intentSchemaFor(user.systemRole);

  try {
    const response = await client.models.generateContent({
      model: process.env.VOICE_MODEL || 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });
    const raw = JSON.parse(response.text ?? '{}');
    return normalizeParsedIntent(raw);
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

  switch (intent) {
    case 'MARK_AVAILABILITY':
      if (typeof raw.date === 'string' && (raw.availabilityType === 'UNAVAILABLE' || raw.availabilityType === 'PREFERRED_OFF')) {
        return { intent: 'MARK_AVAILABILITY', date: raw.date, type: raw.availabilityType, summary };
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
          summary,
        };
      }
      break;
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      if (typeof raw.swapRequestId === 'string') {
        return { intent, swapRequestId: raw.swapRequestId, summary };
      }
      break;
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      if (typeof raw.joinRequestId === 'string') {
        return { intent, joinRequestId: raw.joinRequestId, summary };
      }
      break;
  }
  return {
    intent: 'UNRECOGNIZED',
    reason: typeof raw.unrecognizedReason === 'string' ? raw.unrecognizedReason : 'Could not confidently match this to a supported command.',
    summary,
  };
}
