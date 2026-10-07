import { GoogleGenAI, ApiError, MediaResolution, ThinkingLevel, type GenerateContentResponseUsageMetadata } from '@google/genai';
import {
  developerApiKey,
  vertexCredentials,
  VertexCredentialsError,
  visionConfig,
  type VisionConfig,
} from '../lib/aiConfig.js';
import { focusInstruction, ROSTER_VLM_GEMINI_SCHEMA, ROSTER_VLM_SYSTEM_PROMPT } from './vlmPrompt.js';
import { AiBudgetExceededError, MAX_OUTPUT_TOKENS, visionInputEstimate, withAiBudget } from '../lib/aiBudget.js';

/**
 * What reads a roster the deterministic parsers couldn't: one interface, one real
 * implementation (Gemini — Vertex AI in production, the Developer API for local dev) and one
 * mock for tests and the eval harness. The provider only turns an input into the model's raw
 * JSON text; parseVision.ts / rosterReading.ts own the fallbacks, the mapping to rows and the
 * user-facing errors.
 */

export type VisionInput = {
  originalFilename: string;
  /**
   * Kept for callers of the original API; never sent to the model (a reference week in the
   * prompt biased the model towards the upload week instead of the printed one).
   */
  weekStart?: string;
  /** The venue the read is for (AI usage ledger); null for operator diagnostics. */
  locationId?: string | null;
  /** The signed-in person the read is for (their daily AI quota). */
  userId?: string | null;
  /** Read only this page — and only these person rows of it when `rows` is set. */
  focus?: { page: number; rows?: { from: number; to: number | null } };
  /** The second, stricter read of a page that came back short. */
  strict?: boolean;
  /** The PDF's own text layer, one entry per page, for the model to check names and numbers against. */
  pageTexts?: string[];
  /** Latest moment (epoch ms) this read may still run: attempts and retries stop before it. */
  deadline?: number;
} & (
  | { kind: 'file'; data: Buffer; mimeType: string }
  | { kind: 'grid'; text: string }
);

export interface VisionUsage {
  promptTokens: number | null;
  outputTokens: number | null;
}

export interface VisionOutput {
  /** The model's raw JSON text (roster schema). */
  raw: string;
  /** The model that answered (the fallback model after a retry). */
  model: string;
  usage: VisionUsage;
  /** The answer hit the output-token cap: it is cut off and must not be trusted as complete. */
  truncated?: boolean;
}

/**
 *  - busy               every attempt was rate-limited or overloaded (429/503), or timed out
 *  - model_unavailable  every model answered 404: retired, misspelled, or not offered in this region
 *  - failed             anything else (auth, bad request, empty answer, network)
 *  - paused             the in-app AI spend cap (lib/aiBudget.ts) refused the call; nothing was sent
 */
export type VisionProviderErrorKind = 'busy' | 'model_unavailable' | 'failed' | 'paused';

export class VisionProviderError extends Error {
  kind: VisionProviderErrorKind;
  cause?: unknown;
  constructor(message: string, kind: VisionProviderErrorKind, cause?: unknown) {
    super(message);
    this.name = 'VisionProviderError';
    this.kind = kind;
    this.cause = cause;
  }
}

export interface VisionProvider {
  /** e.g. `vertex-gemini`, `gemini-developer-api`, `mock`. */
  readonly name: string;
  readonly model: string;
  readonly fallbackModel: string;
  /** Vertex location, or null where there is no region to choose. */
  readonly region: string | null;
  readRoster(input: VisionInput): Promise<VisionOutput>;
}

function requestText(input: VisionInput): string {
  const focus = input.focus ? `\n\n${focusInstruction(input.focus.page, input.focus.rows, input.strict)}` : '';
  if (input.kind === 'grid') {
    return (
      `Roster spreadsheet "${input.originalFilename}", given as its cell grid: one line per spreadsheet row, ` +
      `cells separated by a tab character; merged cells repeat their value in every covered cell. Read it ` +
      `exactly as you would the printed page (one page: p = 1).${focus}\n\n${input.text}`
    );
  }
  const layer = input.pageTexts?.some((t) => t.trim())
    ? `\n\nThe file's own text layer follows, page by page (one line per printed row, cells separated by " | "; ` +
      `empty cells are missing from it). Use it to check the spelling of names and the exact numbers; the page ` +
      `itself decides which cell is which day.\n` +
      input.pageTexts.map((t, i) => (input.focus && input.focus.page !== i + 1 ? '' : `--- page ${i + 1} ---\n${t}`)).filter(Boolean).join('\n')
    : '';
  return `Roster file "${input.originalFilename}". Transcribe it per the schema.${focus}${layer}`;
}

function userParts(input: VisionInput) {
  if (input.kind === 'file') {
    return [{ text: requestText(input) }, { inlineData: { mimeType: input.mimeType, data: input.data.toString('base64') } }];
  }
  return [{ text: requestText(input) }];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An attempt needs at least this long; with less time left before the deadline it isn't started. */
const MIN_ATTEMPT_MS = 10_000;

/** Gemini through `@google/genai`: Vertex AI when a project is configured, else the Developer API. */
export class GeminiVisionProvider implements VisionProvider {
  readonly name: string;
  readonly model: string;
  readonly fallbackModel: string;
  readonly region: string | null;
  private client: GoogleGenAI | null;
  private readonly config: VisionConfig;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(config: VisionConfig, options: { client?: GoogleGenAI; wait?: (ms: number) => Promise<void> } = {}) {
    if (!config.backend) throw new Error('GeminiVisionProvider needs a configured backend.');
    this.config = config;
    this.name = config.backend === 'vertex' ? 'vertex-gemini' : 'gemini-developer-api';
    this.model = config.model;
    this.fallbackModel = config.fallbackModel;
    this.region = config.location;
    this.client = options.client ?? null;
    this.wait = options.wait ?? sleep;
  }

  private getClient(): GoogleGenAI {
    if (this.client) return this.client;
    const httpOptions = { timeout: this.config.readTimeoutMs };
    if (this.config.backend === 'vertex') {
      // Credentials: GOOGLE_SERVICE_ACCOUNT_JSON when set, else Application Default
      // Credentials. Nothing about them is ever logged.
      const credentials = vertexCredentials();
      this.client = new GoogleGenAI({
        vertexai: true,
        project: this.config.project!,
        location: this.config.location!,
        httpOptions,
        ...(credentials ? { googleAuthOptions: { credentials } } : {}),
      });
    } else {
      this.client = new GoogleGenAI({ apiKey: developerApiKey()!, httpOptions });
    }
    return this.client;
  }

  async readRoster(input: VisionInput): Promise<VisionOutput> {
    let genai: GoogleGenAI;
    try {
      genai = this.getClient();
    } catch (err) {
      // Only our own credential message is safe to log verbatim (it never echoes the value).
      console.error(`[vision] ${this.name} client setup failed: ${err instanceof VertexCredentialsError ? err.message : 'unexpected error'}`);
      throw new VisionProviderError('Vision client could not be set up.', 'failed', err);
    }
    // Primary model first; on 429/503 back off and retry on the fallback model (twice), so a
    // temporary spike doesn't fail the manager's upload. A 404 moves straight to the next
    // model too: a retired primary should not take the fallback down with it. No attempt
    // starts when too little time is left before the read's deadline.
    const attempts = [
      { model: this.model, delayMs: 0 },
      { model: this.fallbackModel, delayMs: 1000 },
      { model: this.fallbackModel, delayMs: 2000 },
    ];
    let lastError: unknown;
    let sawNotFound = false;
    let sawTransient = false;
    for (const [i, attempt] of attempts.entries()) {
      if (attempt.delayMs > 0) await this.wait(attempt.delayMs);
      const remaining = input.deadline ? input.deadline - Date.now() : Infinity;
      if (remaining < MIN_ATTEMPT_MS) {
        sawTransient = sawTransient || i > 0;
        lastError = lastError ?? new Error('read deadline reached');
        break;
      }
      const timeout = Math.min(this.config.readTimeoutMs, remaining - 1000);
      try {
        // Every attempt is its own model call, so each one goes through the spend cap.
        const response = await withAiBudget(
          {
            locationId: input.locationId ?? null,
            userId: input.userId ?? null,
            feature: 'roster_vision',
            // The text layer sent alongside a PDF counts too (about 3 characters a token, rounded up).
            inputTokensEstimate: visionInputEstimate(input) + Math.ceil((input.pageTexts?.join('\n').length ?? 0) / 3),
          },
          async () => {
            const r = await genai.models.generateContent({
              model: attempt.model,
              contents: [{ role: 'user', parts: userParts(input) }],
              config: {
                systemInstruction: ROSTER_VLM_SYSTEM_PROMPT,
                temperature: 0,
                responseMimeType: 'application/json',
                responseSchema: ROSTER_VLM_GEMINI_SCHEMA,
                maxOutputTokens: MAX_OUTPUT_TOKENS.roster_vision,
                thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
                // Small print on a dense page: read it at the highest resolution offered.
                ...(input.kind === 'file' ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH } : {}),
                httpOptions: { timeout },
              },
            });
            return { value: r, usage: { inputTokens: r.usageMetadata?.promptTokenCount ?? null, outputTokens: billedOutputTokens(r.usageMetadata) } };
          },
        );
        const raw = response?.text;
        if (!raw) throw new VisionProviderError('Vision model returned an empty response.', 'failed');
        const truncated = response.candidates?.[0]?.finishReason === 'MAX_TOKENS';
        if (truncated) console.warn(`[vision] model "${attempt.model}" hit the output cap — the answer is cut off and is treated as incomplete.`);
        return {
          raw,
          model: attempt.model,
          usage: {
            promptTokens: response.usageMetadata?.promptTokenCount ?? null,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
          },
          ...(truncated ? { truncated } : {}),
        };
      } catch (err) {
        if (err instanceof AiBudgetExceededError) {
          console.warn(`[vision] AI spend cap reached (${err.limit}) — no call made.`);
          throw new VisionProviderError('The AI spend cap for this period has been reached.', 'paused', err);
        }
        lastError = err;
        const status = err instanceof ApiError ? err.status : undefined;
        const next = attempts[i + 1]?.model;
        if (status === 404) {
          sawNotFound = true;
          console.error(
            `[vision] MODEL NOT AVAILABLE: ${this.name} answered 404 for model "${attempt.model}"` +
              `${this.region ? ` in location "${this.region}"` : ''}. It may be retired, misspelled, or not offered there. ` +
              `Set VLM_MODEL / VLM_FALLBACK_MODEL (and GEMINI_VERTEX_LOCATION) to a current model — see docs/vlm-go-live.md.` +
              (next ? ` Trying "${next}".` : ''),
          );
          continue;
        }
        // 504 (and a client-side timeout) is the model running out of time on a long read: worth another try.
        const timedOut = status === 504 || (err instanceof Error && /timed? ?out|deadline|abort/i.test(err.message) && status === undefined);
        if (status === 429 || status === 503 || timedOut) {
          sawTransient = true;
          console.warn(
            `[vision] model "${attempt.model}" answered ${status ?? 'timeout'} (${status === 429 ? 'rate limit/quota' : status === 503 ? 'high demand' : 'took too long'})` +
              (next ? `; retrying with "${next}".` : '.'),
          );
          continue;
        }
        if (err instanceof VisionProviderError) throw err;
        throw new VisionProviderError(`Vision model request failed${status ? ` (${status})` : ''}.`, 'failed', err);
      }
    }
    if (sawTransient) throw new VisionProviderError('Vision model was busy on every attempt.', 'busy', lastError);
    if (sawNotFound) throw new VisionProviderError('No configured vision model is available.', 'model_unavailable', lastError);
    throw new VisionProviderError('Vision model request failed.', 'failed', lastError);
  }
}

/** Output tokens Gemini bills: the answer plus any "thinking" tokens. Null when the response carried no counts. */
export function billedOutputTokens(usage: GenerateContentResponseUsageMetadata | undefined): number | null {
  if (usage?.candidatesTokenCount == null) return null;
  return usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0);
}

/** Test/eval double: answers from a function (or a fixed raw JSON string) without any network call. */
export class MockVisionProvider implements VisionProvider {
  readonly name = 'mock';
  readonly model: string;
  readonly fallbackModel: string;
  readonly region = null;
  readonly calls: VisionInput[] = [];
  private readonly answer: (input: VisionInput) => VisionOutput | Promise<VisionOutput>;

  constructor(answer: string | ((input: VisionInput) => VisionOutput | Promise<VisionOutput>), model = 'mock-model') {
    this.model = model;
    this.fallbackModel = model;
    this.answer = typeof answer === 'string' ? () => ({ raw: answer, model, usage: { promptTokens: null, outputTokens: null } }) : answer;
  }

  async readRoster(input: VisionInput): Promise<VisionOutput> {
    this.calls.push(input);
    return this.answer(input);
  }
}

let providerOverride: VisionProvider | null = null;
let clientOverride: GoogleGenAI | null = null;
let cached: { key: string; provider: GeminiVisionProvider } | null = null;

/**
 * The provider for this request, or null when vision isn't configured. Built from the current
 * environment (re-read each call; the client is reused while the settings don't change).
 */
export function getVisionProvider(): VisionProvider | null {
  if (providerOverride) return providerOverride;
  const config = visionConfig();
  if (!config.backend) return null;
  const key = JSON.stringify(config);
  if (!cached || cached.key !== key || clientOverride) {
    cached = { key, provider: new GeminiVisionProvider(config, clientOverride ? { client: clientOverride } : {}) };
  }
  return cached.provider;
}

/** Test seam: use this provider (e.g. a MockVisionProvider) instead of the configured one. null restores. */
export function __setVisionProviderForTests(provider: VisionProvider | null): void {
  providerOverride = provider;
}

/** Test seam: keep the real Gemini provider logic but swap its SDK client. null restores. */
export function __setGeminiClientForTests(fake: GoogleGenAI | null): void {
  clientOverride = fake;
  cached = null;
}
