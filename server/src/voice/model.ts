import { ApiError, type GoogleGenAIOptions } from '@google/genai';
import { developerApiKey, vertexCredentials, voiceConfig } from '../lib/aiConfig.js';

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
 * Same backend, credentials, region and timeout as roster vision
 * (lib/aiConfig.ts): Vertex AI when GEMINI_VERTEX_PROJECT is set, otherwise the
 * Developer API key. GEMINI_BASE_URL (dev/e2e only — productionGuards.ts
 * refuses to boot with it in production) points them at a local fake Gemini,
 * which needs no real key. Roster vision parsing doesn't read it.
 * Throws VertexCredentialsError for an unreadable service-account variable.
 * Never log the return value.
 */
export function voiceClientOptions(env: NodeJS.ProcessEnv = process.env): GoogleGenAIOptions | null {
  const baseUrl = env.GEMINI_BASE_URL?.trim();
  if (baseUrl) return { apiKey: env.GEMINI_API_KEY || 'local-fake-gemini', httpOptions: { baseUrl } };
  const config = voiceConfig(env);
  const httpOptions = { timeout: config.timeoutMs };
  if (config.backend === 'vertex') {
    const credentials = vertexCredentials(env);
    return {
      vertexai: true,
      project: config.project!,
      location: config.location!,
      httpOptions,
      ...(credentials ? { googleAuthOptions: { credentials } } : {}),
    };
  }
  if (config.backend === 'developer-api') return { apiKey: developerApiKey(env)!, httpOptions };
  return null;
}
