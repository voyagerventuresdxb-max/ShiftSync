import type { VoiceInteractionOutcome } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { ParsedIntent } from './intentSchema.js';
import type { VoiceIntentResolution } from './parseIntent.js';

/**
 * Classifies a fresh parse result into its at-parse-time outcome —
 * EXECUTED/REJECTED_* only happen later, at /execute (see
 * updateInteractionOutcome below).
 */
function outcomeAtParseTime(resolution: VoiceIntentResolution): VoiceInteractionOutcome {
  if (resolution.attempted.intent === 'UNRECOGNIZED') return 'UNRECOGNIZED';
  if (resolution.response.intent === 'UNRECOGNIZED') return 'LOW_CONFIDENCE';
  return 'PENDING_CONFIRMATION';
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
      outcome: outcomeAtParseTime(resolution),
    },
    select: { id: true },
  });
  return row.id;
}

/** Called from /execute right before its response is sent, to record the final outcome of a PENDING_CONFIRMATION row. */
export async function updateInteractionOutcome(
  logId: string,
  outcome: VoiceInteractionOutcome,
  declineReason?: string,
): Promise<void> {
  await prisma.voiceInteractionLog.update({
    where: { id: logId },
    data: { outcome, declineReason: declineReason ?? null },
  });
}
