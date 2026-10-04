import { ApiError } from '@google/genai';
import { voiceConfig } from '../lib/aiConfig.js';

/**
 * Which Gemini model both halves of the voice pipeline (transcribe.ts and
 * parseIntent.ts) use. The ID and its default live in lib/aiConfig.ts, the one
 * place model IDs are configured; this reads it at CALL time, so a
 * `VOICE_MODEL` set after import (dotenv load order, tests) is still honoured.
 */
export function voiceModel(): string {
  return voiceConfig().model;
}

/**
 * A 404 from Gemini means the configured model isn't available (retired,
 * misspelled, or not offered to this key) — an operator fix, not a retry.
 * Logs it loudly with the model ID (never any credential) and returns true.
 */
export function reportIfModelUnavailable(stage: 'transcribe' | 'parse-intent', err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 404) return false;
  console.error(
    `[voice.${stage}] MODEL NOT AVAILABLE: Gemini answered 404 for model "${voiceModel()}". It may be retired or misspelled. ` +
      'Set VOICE_MODEL to a current model (see docs/ENV_VARS.md). Voice commands fail until then.',
  );
  return true;
}

/**
 * Options for both voice Gemini clients, or null when voice isn't configured.
 * GEMINI_BASE_URL (dev/e2e only — productionGuards.ts refuses to boot with it
 * in production) points them at a local fake Gemini, which needs no real key.
 * Roster vision parsing (parseVision.ts) deliberately doesn't read it.
 */
export function voiceClientOptions(
  env: NodeJS.ProcessEnv = process.env,
): { apiKey: string; httpOptions?: { baseUrl: string } } | null {
  const baseUrl = env.GEMINI_BASE_URL?.trim();
  const apiKey = env.GEMINI_API_KEY || (baseUrl ? 'local-fake-gemini' : '');
  if (!apiKey) return null;
  return baseUrl ? { apiKey, httpOptions: { baseUrl } } : { apiKey };
}
