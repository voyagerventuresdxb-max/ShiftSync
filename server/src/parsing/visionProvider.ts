import { GoogleGenAI, ApiError, ThinkingLevel, type GenerateContentResponseUsageMetadata } from '@google/genai';
import {
  developerApiKey,
  vertexCredentials,
  VertexCredentialsError,
  visionConfig,
  type VisionConfig,
} from '../lib/aiConfig.js';
import { ROSTER_VLM_GEMINI_SCHEMA, ROSTER_VLM_SYSTEM_PROMPT } from './vlmPrompt.js';
import { AiBudgetExceededError, MAX_OUTPUT_TOKENS, visionInputEstimate, withAiBudget } from '../lib/aiBudget.js';

/**
 * What reads a roster the deterministic parsers couldn't: one interface, one real
 * implementation (Gemini — Vertex AI in production, the Developer API for local dev) and one
 * mock for tests and the eval harness. The provider only turns an input into the model's raw
 * JSON text; parseVision.ts owns the fallbacks, the mapping to rows and the user-facing errors.
 */

export type VisionInput = {
  originalFilename: string;
  weekStart?: string;
  /** The venue the read is for (AI usage ledger); null for operator diagnostics. */
  locationId?: string | null;
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
}

/**
 *  - busy               every attempt was rate-limited or overloaded (429/503)
 *  - model_unavailable  every model answered 404: retired, misspelled, or not offered in this region
 *  - failed             anything else (auth, bad request, empty answer, network)
 */
/** `paused`: the in-app AI spend cap (lib/aiBudget.ts) refused the call; nothing was sent. */
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

function referenceWeekText(weekStart?: string): string {
  return weekStart
    ? ` The current active roster week starts on ${weekStart} (a Monday; every rota week here runs Monday to Sunday). Use this as the reference week to resolve day-month dates and to anchor the week's date range.`
    : '';
}

function userParts(input: VisionInput) {
  const week = referenceWeekText(input.weekStart);
  if (input.kind === 'file') {
    return [
      { text: `Roster image filename: "${input.originalFilename}". Extract it per the schema.${week}` },
      { inlineData: { mimeType: input.mimeType, data: input.data.toString('base64') } },
    ];
  }
  return [
    {
      text:
        `Roster spreadsheet filename: "${input.originalFilename}". This roster did not match any of ` +
        `ShiftSync's known long-format column templates, so it is being read as a raw grid instead. ` +
        `Below is the sheet's cell grid as plain text: each line is one spreadsheet row, cells within ` +
        `a row are separated by a tab character. Merged cells have already been expanded so every ` +
        `covered cell repeats the merged value. Analyze this exactly as you would a photographed/` +
        `screenshotted roster image — apply the same spatial grid analysis to the row/column layout of ` +
        `this text. Extract it per the schema.${week}\n\n${input.text}`,
    },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    const httpOptions = { timeout: this.config.timeoutMs };
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
    // model too: a retired primary should not take the fallback down with it.
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
      try {
        // Every attempt is its own model call, so each one goes through the spend cap.
        const response = await withAiBudget(
          { locationId: input.locationId ?? null, feature: 'roster_vision', inputTokensEstimate: visionInputEstimate(input) },
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
              },
            });
            return { value: r, usage: { inputTokens: r.usageMetadata?.promptTokenCount ?? null, outputTokens: billedOutputTokens(r.usageMetadata) } };
          },
        );
        const raw = response?.text;
        if (!raw) throw new VisionProviderError('Vision model returned an empty response.', 'failed');
        return {
          raw,
          model: attempt.model,
          usage: {
            promptTokens: response.usageMetadata?.promptTokenCount ?? null,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
          },
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
        if (status === 429 || status === 503) {
          sawTransient = true;
          console.warn(
            `[vision] model "${attempt.model}" answered ${status} (${status === 429 ? 'rate limit/quota' : 'high demand'})` +
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
