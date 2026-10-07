import type { VoiceInteractionOutcome } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { ParsedIntent } from './intentSchema.js';
import { CONFIDENCE_THRESHOLD, type VoiceIntentResolution } from './parseIntent.js';
import { VOICE_ROLE_REFUSAL } from '../../../shared/voiceIntents.js';

/**
 * Classifies a fresh parse result into its at-parse-time outcome —
 * EXECUTED/REJECTED_* only happen later, at /execute (see
 * updateInteractionOutcome below).
 */
export function outcomeAtParseTime(resolution: VoiceIntentResolution): VoiceInteractionOutcome {
  const { attempted, response } = resolution;
  if (attempted.intent === 'UNRECOGNIZED') return 'UNRECOGNIZED';
  if (response.intent === 'UNRECOGNIZED') {
    // Why nothing was offered: the caller's role, the confidence gate, or a propose-time check
    // (an id not at the venue, a past date, an overlap, an empty week, an ambiguous template).
    if (response.reason === VOICE_ROLE_REFUSAL) return 'REJECTED_PERMISSION';
    return attempted.confidence < CONFIDENCE_THRESHOLD ? 'LOW_CONFIDENCE' : 'REJECTED_VALIDATION';
  }
  if (resolution.response.intent === 'QUERY_MY_SCHEDULE') return 'ANSWERED';
  return 'PENDING_CONFIRMATION';
}

/**
 * Whether the client-facing response should carry the "there's more, go
 * again" signal. False whenever the primary intent's own response ended up
 * UNRECOGNIZED — whether the model genuinely didn't understand it, or the
 * confidence gate coerced it there — since compounding a "didn't catch
 * that" message with a "there's more" prompt in the same turn would read as
 * two separate problems instead of one. The raw hasAdditionalRequest signal
 * is still always logged via logParsedInteraction below, regardless of this
 * function's result — this only gates what the CALLER sees, not what gets
 * recorded.
 */
export function shouldPromptForAdditionalRequest(resolution: VoiceIntentResolution): boolean {
  return resolution.hasAdditionalRequest && resolution.response.intent !== 'UNRECOGNIZED';
}

/**
 * Why a parse ended in a question rather than a Confirm, for the log: about a person (the kind, and
 * how many people were offered: "person_missing:0", "person_ambiguous:2") and/or a recognised
 * command missing parts ("incomplete:CREATE_SHIFT:end,roleId"). Kinds, counts and field names
 * only — never a name, a note's text or an id. Null for every other outcome.
 */
export function noteAtParseTime(resolution: VoiceIntentResolution): string | null {
  const { response } = resolution;
  if (response.intent !== 'UNRECOGNIZED') return null;
  const notes = [
    response.person ? `person_${response.person.status}:${response.options?.length ?? 0}` : null,
    response.incomplete ? `incomplete:${response.incomplete.intent}:${response.incomplete.missing.join(',')}` : null,
  ].filter(Boolean);
  return notes.length ? notes.join(' ') : null;
}

/**
 * Writes one row per /parse-intent call — every real attempt, regardless
 * of outcome. Called AFTER parseVoiceIntent resolves successfully (a
 * VoiceIntentError from the Gemini call itself is never logged here — see
 * routes/voice.ts's /parse-intent handler, which only calls this on the
 * success path). Returns the row's id so the client can round-trip it
 * back on /execute.
 */
export async function logParsedInteraction(
  user: { id: string; locationId: string },
  transcript: string,
  resolution: VoiceIntentResolution,
): Promise<string> {
  const attempted = resolution.attempted as ParsedIntent;
  const confidence = attempted.intent === 'UNRECOGNIZED' ? null : attempted.confidence;
  const row = await prisma.voiceInteractionLog.create({
    data: {
      locationId: user.locationId,
      actorId: user.id,
      transcript,
      resolvedIntent: attempted.intent,
      confidence,
      hasAdditionalRequest: resolution.hasAdditionalRequest,
      outcome: outcomeAtParseTime(resolution),
      // Why nothing was offered outright: a person who couldn't be pinned down, or a missing part.
      // If the caller then picks someone and confirms, /execute records the outcome as usual.
      declineReason: noteAtParseTime(resolution),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Called from /execute right before its response is sent, to record the
 * final outcome of a PENDING_CONFIRMATION row. Scoped to `actorId` — a
 * client can send an arbitrary `voiceLogId` in its /execute request body,
 * and without this scope that would let any authenticated session overwrite
 * another user's (or another location's) audit-trail row. `updateMany`
 * silently no-ops when `logId` doesn't belong to `actorId`, consistent with
 * this call's already-established best-effort/non-blocking semantics (it's
 * wrapped in a `.catch()` at the call site).
 *
 * `confirmedIntent`: the intent the caller confirmed. It differs from the
 * logged reading only when they picked another one from a "which did you
 * mean?" list, and then the row names what was actually confirmed.
 */
export async function updateInteractionOutcome(
  logId: string,
  actorId: string,
  outcome: VoiceInteractionOutcome,
  declineReason?: string,
  confirmedIntent?: string,
): Promise<void> {
  await prisma.voiceInteractionLog.updateMany({
    where: { id: logId, actorId },
    data: {
      outcome,
      // An executed command keeps its parse-time note (a "which Omar?" question it answered);
      // a refusal records why it was refused.
      ...(outcome === 'EXECUTED' && !declineReason ? {} : { declineReason: declineReason ?? null }),
      ...(confirmedIntent ? { resolvedIntent: confirmedIntent } : {}),
    },
  });
}
