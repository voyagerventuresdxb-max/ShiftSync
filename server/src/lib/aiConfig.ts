/**
 * The one place that decides which Gemini models, region and project the AI features use.
 *
 * Every model ID, region and project setting is read here, from the environment, at CALL
 * time (so dotenv load order and tests that set a variable after import both work). No other
 * module may contain a model-ID literal; `aiConfig.test.ts` enforces that.
 *
 * Defaults were checked against Google's model docs on 2026-10-04 (see docs/vlm-go-live.md):
 *  - `gemini-3.6-flash` and `gemini-3.5-flash-lite` are GA on the Gemini Developer API and on
 *    Vertex AI, with no retirement announced before 2027.
 *  - On Vertex AI both are offered only on the `global` endpoint and the `us` / `eu`
 *    multi-regions, NOT in any single EU region (europe-west4 included). `eu` keeps processing
 *    inside the EU, so it is the default.
 *
 * Credentials are deliberately NOT part of the returned config objects (they get logged and
 * printed by diagnostics); callers that build a client read them through `vertexCredentials()`
 * / `developerApiKey()` and pass them straight to the SDK.
 */

export const DEFAULT_VISION_MODEL = 'gemini-3.6-flash';
export const DEFAULT_VISION_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_VOICE_MODEL = 'gemini-3.6-flash';
export const DEFAULT_VERTEX_LOCATION = 'eu';
export const DEFAULT_GEMINI_HTTP_TIMEOUT_MS = 30_000;

export type VisionBackend = 'vertex' | 'developer-api';

export interface VisionConfig {
  /** null = not configured: no Vertex project and no Developer API key. */
  backend: VisionBackend | null;
  model: string;
  fallbackModel: string;
  /** Vertex AI only. */
  project: string | null;
  /** Vertex AI location (`eu`, `us`, `global` or a region); null on the Developer API. */
  location: string | null;
  timeoutMs: number;
}

export interface VoiceConfig {
  model: string;
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

export function visionConfig(env: NodeJS.ProcessEnv = process.env): VisionConfig {
  const project = trimmed(env.GEMINI_VERTEX_PROJECT) || null;
  const backend: VisionBackend | null = project ? 'vertex' : trimmed(env.GEMINI_API_KEY) ? 'developer-api' : null;
  const timeout = Number(env.GEMINI_HTTP_TIMEOUT_MS);
  return {
    backend,
    model: trimmed(env.VLM_MODEL) || DEFAULT_VISION_MODEL,
    fallbackModel: trimmed(env.VLM_FALLBACK_MODEL) || DEFAULT_VISION_FALLBACK_MODEL,
    project,
    location: backend === 'vertex' ? trimmed(env.GEMINI_VERTEX_LOCATION) || DEFAULT_VERTEX_LOCATION : null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_GEMINI_HTTP_TIMEOUT_MS,
  };
}

export function voiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  return { model: trimmed(env.VOICE_MODEL) || DEFAULT_VOICE_MODEL };
}

/** The Gemini Developer API key, or null. Never log the return value. */
export function developerApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimmed(env.GEMINI_API_KEY) || null;
}

export class VertexCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VertexCredentialsError';
  }
}

/**
 * Service-account credentials for Vertex AI from `GOOGLE_SERVICE_ACCOUNT_JSON` (the whole key
 * file's JSON, set by hand as a secret variable — Railway can't mount a key file), or
 * undefined to fall back to Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`
 * pointing at a file, or workload identity). Throws a message that names the problem but never
 * echoes any of the value. Never log the return value.
 */
export function vertexCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { client_email: string; private_key: string } | undefined {
  const raw = trimmed(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VertexCredentialsError('GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON (paste the whole key file).');
  }
  const creds = parsed as { client_email?: unknown; private_key?: unknown };
  if (typeof creds.client_email !== 'string' || typeof creds.private_key !== 'string') {
    throw new VertexCredentialsError('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key (paste the whole key file).');
  }
  return { client_email: creds.client_email, private_key: creds.private_key };
}

/** One line for logs and diagnostics: backend, model and region. No credentials, no project id. */
export function describeVisionConfig(config: VisionConfig = visionConfig()): string {
  if (!config.backend) return 'vision: not configured (set GEMINI_VERTEX_PROJECT for Vertex AI, or GEMINI_API_KEY)';
  const where = config.backend === 'vertex' ? `vertex location=${config.location}` : 'developer-api';
  return `vision: ${where} model=${config.model} fallback=${config.fallbackModel}`;
}

/** Share of a deterministic grid result's shift rows with no role above which the roster is escalated to vision. */
export const DEFAULT_ESCALATE_EMPTY_ROLE_SHARE = 0.3;

export interface EscalationConfig {
  /** 0–1, from `ROSTER_ESCALATE_EMPTY_ROLE_SHARE`; out-of-range or non-numeric values use the default. */
  emptyRoleShare: number;
}

export function escalationConfig(env: NodeJS.ProcessEnv = process.env): EscalationConfig {
  const raw = trimmed(env.ROSTER_ESCALATE_EMPTY_ROLE_SHARE);
  const share = raw === '' ? NaN : Number(raw);
  return { emptyRoleShare: Number.isFinite(share) && share >= 0 && share <= 1 ? share : DEFAULT_ESCALATE_EMPTY_ROLE_SHARE };
}
