import { GoogleGenAI, ApiError, ThinkingLevel } from '@google/genai';
import { visionConfig, voiceConfig, VertexCredentialsError, type VisionBackend } from './aiConfig.js';
import { AiBudgetExceededError, MAX_OUTPUT_TOKENS, withAiBudget, type AiFeature } from './aiBudget.js';
import { voiceClientOptions } from '../voice/model.js';
import { billedOutputTokens } from '../parsing/visionProvider.js';

/**
 * The owner's "Test AI connection": one tiny call per feature, on the same
 * backend, model and region the real feature uses, through the spend cap like
 * any other call. Reports only what an owner needs to act on — never a
 * provider message, project id or credential.
 */

export type AiSelfTestReason =
  | 'not_configured'
  | 'credentials'
  | 'access_denied'
  | 'model_unavailable'
  | 'paused_today'
  | 'paused_month'
  | 'unavailable'
  | 'failed';

export interface AiSelfTestCheck {
  ok: boolean;
  backend: VisionBackend | null;
  model: string;
  /** Vertex location (e.g. `eu`); null on the Developer API or when not configured. */
  location: string | null;
  latencyMs: number | null;
  reason?: AiSelfTestReason;
}

export interface AiSelfTestResult {
  vision: AiSelfTestCheck;
  voice: AiSelfTestCheck;
}

/** A 1×1 PNG: the smallest image that still exercises the image path. */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A quarter-second of 16 kHz mono 16-bit silence as WAV: the smallest clip that still exercises the audio path. */
export function silentWav(ms = 250): Buffer {
  const rate = 16_000;
  const dataBytes = Math.round((rate * ms) / 1000) * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

const PROMPT = 'This is a connection test. Reply with the single word OK.';

let clientOverride: GoogleGenAI | null = null;
/** Test seam: a fake Gemini client. Pass null to restore. */
export function __setSelfTestClientForTests(fake: GoogleGenAI | null): void {
  clientOverride = fake;
}

function reasonFor(err: unknown): AiSelfTestReason {
  if (err instanceof AiBudgetExceededError) {
    return err.limit === 'daily_calls' ? 'paused_today' : err.limit === 'monthly_budget' ? 'paused_month' : 'unavailable';
  }
  if (err instanceof VertexCredentialsError) return 'credentials';
  if (err instanceof ApiError) {
    if (err.status === 404) return 'model_unavailable';
    if (err.status === 401 || err.status === 403) return 'access_denied';
    if (err.status === 429 || (err.status ?? 0) >= 500) return 'unavailable';
    return 'failed';
  }
  return 'unavailable';
}

async function runCheck(
  label: 'vision' | 'voice',
  base: Omit<AiSelfTestCheck, 'ok' | 'latencyMs' | 'reason'>,
  feature: AiFeature,
  media: { mimeType: string; data: string },
  locationId: string,
): Promise<AiSelfTestCheck> {
  let genai: GoogleGenAI;
  try {
    const options = clientOverride ? null : voiceClientOptions();
    if (!clientOverride && !options) return { ...base, ok: false, latencyMs: null, reason: 'not_configured' };
    genai = clientOverride ?? new GoogleGenAI(options!);
  } catch (err) {
    console.error(`[ai.self-test] ${label}: credentials could not be read`);
    return { ...base, ok: false, latencyMs: null, reason: reasonFor(err) };
  }
  let latencyMs: number | null = null;
  try {
    await withAiBudget({ locationId, feature, inputTokensEstimate: 2_000 }, async () => {
      const started = Date.now();
      const r = await genai.models.generateContent({
        model: base.model,
        contents: [{ role: 'user', parts: [{ text: PROMPT }, { inlineData: media }] }],
        config: { maxOutputTokens: MAX_OUTPUT_TOKENS[feature], thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
      });
      latencyMs = Date.now() - started;
      return { value: r, usage: { inputTokens: r.usageMetadata?.promptTokenCount ?? null, outputTokens: billedOutputTokens(r.usageMetadata) } };
    });
    return { ...base, ok: true, latencyMs };
  } catch (err) {
    const reason = reasonFor(err);
    console.error(`[ai.self-test] ${label} failed: ${reason}${err instanceof ApiError ? ` (status ${err.status})` : ''}`);
    return { ...base, ok: false, latencyMs, reason };
  }
}

export async function runAiSelfTest(locationId: string): Promise<AiSelfTestResult> {
  const vision = visionConfig();
  const voice = voiceConfig();
  // Sequential: two calls at once would only make the latencies harder to read.
  const visionCheck = await runCheck(
    'vision',
    { backend: vision.backend, model: vision.model, location: vision.location },
    'self_test_vision',
    { mimeType: 'image/png', data: TINY_PNG_BASE64 },
    locationId,
  );
  const voiceCheck = await runCheck(
    'voice',
    { backend: voice.backend, model: voice.model, location: voice.location },
    'self_test_voice',
    { mimeType: 'audio/wav', data: silentWav().toString('base64') },
    locationId,
  );
  return { vision: visionCheck, voice: voiceCheck };
}
