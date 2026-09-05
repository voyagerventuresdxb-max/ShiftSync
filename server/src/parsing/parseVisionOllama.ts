/**
 * Local Ollama vision-model ingestion — the LAST-RESORT fallback path for
 * a genuinely scanned/photographed roster (no Excel structure, no PDF text
 * layer for the deterministic paths to read). Runs entirely on the local
 * machine via Ollama: no external API key, no per-upload network call to a
 * third party, no roster data leaving the venue's own network.
 *
 * Reuses the exact same system prompt and extraction contract as the
 * Gemini path (ROSTER_VLM_SYSTEM_PROMPT, VlmResponse, mapVlmResponseToResult)
 * — only the transport (local Ollama HTTP API instead of the Gemini SDK)
 * and the JSON-schema shape passed for structured output differ.
 */
import { Agent, fetch as undiciFetch } from 'undici';
import { ROSTER_VLM_SYSTEM_PROMPT, ROSTER_VLM_JSON_SCHEMA } from './vlmPrompt.js';
import { mapVlmResponseToResult, VisionIngestionError, type VlmResponse } from './parseVision.js';
import { normalizeHeader } from './templates.js';
import type { ParsedVisionResult } from './types.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_VLM_MODEL = process.env.OLLAMA_VLM_MODEL || 'qwen2.5vl:7b';
// Local vision inference is slow when the model doesn't fully fit in GPU
// VRAM (falls back to a CPU/GPU split) — a dense real-world roster image
// measured 5+ minutes on a 6GB-VRAM laptop GPU. This is the rare
// last-resort path (Excel/text-PDF uploads never reach it), so trading
// latency for staying fully local/no-API-dependency is an accepted
// tradeoff rather than a bug to route around. 10 minutes gives real local
// inference room without hanging forever if Ollama is genuinely unreachable.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 600_000;
// Ollama defaults to a small context window (as low as 4096 tokens)
// regardless of what the model itself supports, unless explicitly
// overridden per-request. The full system prompt + JSON schema + an
// image's own token cost routinely exceeds that default and fails with a
// 400 "exceeds the available context size" error — num_ctx must be set
// explicitly on every call, not just for large rosters.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 16384;

// Node's built-in global `fetch` (undici under the hood) has its own
// internal headersTimeout that defaults to 300s and fires independently of
// any AbortController signal passed to the call — measured live: a slow
// local inference response got killed by this at ~357s even with a 600s
// AbortController timeout configured. Routing through the `undici` package
// directly with an explicit Agent lets headersTimeout/bodyTimeout actually
// be raised to match OLLAMA_TIMEOUT_MS. Exposed as an object (not a bare
// function) so tests can mock `ollamaHttp.fetch` directly.
const ollamaAgent = new Agent({
  headersTimeout: OLLAMA_TIMEOUT_MS,
  bodyTimeout: OLLAMA_TIMEOUT_MS,
  connectTimeout: 10_000,
});
export const ollamaHttp = {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
    undiciFetch(url, { ...init, dispatcher: ollamaAgent }),
};

async function ollamaChat(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  jsonSchema: unknown,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const response = await ollamaHttp.fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt, images: [imageBase64] },
        ],
        format: jsonSchema,
        stream: false,
        options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new VisionIngestionError(`Ollama request failed (${response.status}): ${text || response.statusText}`);
    }
    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content;
    if (!content) {
      throw new VisionIngestionError('Ollama returned an empty response.');
    }
    return content;
  } catch (err) {
    if (err instanceof VisionIngestionError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new VisionIngestionError(
        `Ollama request timed out after ${OLLAMA_TIMEOUT_MS}ms — is "ollama serve" running and is the model pulled ("ollama pull ${OLLAMA_VLM_MODEL}")?`,
        err,
      );
    }
    throw new VisionIngestionError(`Could not reach local Ollama at ${OLLAMA_HOST}: ${(err as Error).message}`, err);
  } finally {
    clearTimeout(timeout);
  }
}

const NAMES_ONLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { names: { type: 'array', items: { type: 'string' } } },
  required: ['names'],
};

/**
 * Cheap, narrow call: just the staff names visible in the image, nothing
 * else. This is the independent baseline the completeness check compares
 * the full structured extraction against — a much smaller ask, so it's far
 * less likely to itself truncate, making it a reasonable proxy for "every
 * staff name detectable in the raw input."
 */
async function extractStaffNamesOnly(model: string, imageBase64: string, originalFilename: string): Promise<string[]> {
  const raw = await ollamaChat(
    model,
    'You are a careful visual reader. Output ONLY the JSON described by the schema — no prose, no markdown.',
    `Look at this roster image ("${originalFilename}") and list every distinct staff/employee name printed down the side of the grid — every row, even ones with no visible shifts this week. Do not include role labels, section headers, day names, or notes — names only, one entry per person.`,
    imageBase64,
    NAMES_ONLY_SCHEMA,
  );
  try {
    const parsed = JSON.parse(raw) as { names?: unknown };
    return Array.isArray(parsed.names) ? parsed.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * Was its own local `[^a-z0-9]+` ASCII-only reimplementation — that meant
 * two DIFFERENT Arabic names both normalized to the same empty string, so
 * this completeness check couldn't distinguish "the extraction really has
 * this Arabic employee" from "it's missing them," silently defeating the
 * exact safety net this function exists to provide for a real GCC/Dubai
 * roster. Now uses the shared, already-fixed `normalizeHeader` (see
 * templates.ts and resolveRows.ts's `nameKey`, which use the identical
 * function) so a fix to name-key collisions applies here too instead of
 * drifting out of sync with a second, independent copy.
 */
const normalizeNameForCompare = normalizeHeader;

/** Every employee name accounted for anywhere in the result — a shift row, an anomaly, or a leave record. */
function namesInResult(result: ParsedVisionResult): Set<string> {
  const names = new Set<string>();
  for (const r of result.rows) names.add(normalizeNameForCompare(r.employeeName));
  for (const a of result.anomalies) if (a.employeeName) names.add(normalizeNameForCompare(a.employeeName));
  for (const l of result.leaveRecords) names.add(normalizeNameForCompare(l.employeeName));
  return names;
}

/**
 * Parses a roster image via the local Ollama vision model, with a
 * completeness safety check: a cheap "list the names" call runs first as
 * an independent baseline; if the full structured extraction is missing
 * any name that baseline found, it retries the full extraction once
 * (silently, before ever returning to the caller) rather than surfacing an
 * incomplete roster with no signal that something was dropped.
 */
export async function parseRosterImageOllama(
  imageBuffer: Buffer,
  _mimeType: string, // unused — Ollama's images array auto-detects format; kept for call-site symmetry with parseRosterImage (Gemini)
  originalFilename: string,
  weekStart?: string,
): Promise<ParsedVisionResult> {
  const model = OLLAMA_VLM_MODEL;
  const imageBase64 = imageBuffer.toString('base64');
  const referenceWeek = weekStart
    ? ` The current active roster week starts on ${weekStart} (ISO Sunday). Use this as the reference week to resolve day-month dates and to anchor the week's date range.`
    : '';
  const userPrompt = `Roster image filename: "${originalFilename}". Extract it per the schema.${referenceWeek}`;

  // A failure of the (best-effort) completeness baseline shouldn't block
  // the actual extraction — treat it as "no baseline available" rather
  // than failing the whole upload.
  const detectedNames = await extractStaffNamesOnly(model, imageBase64, originalFilename).catch((err) => {
    console.warn('[parseVisionOllama] Name-detection baseline call failed, skipping completeness check:', err);
    return [] as string[];
  });

  const runExtraction = async (): Promise<ParsedVisionResult> => {
    const raw = await ollamaChat(model, ROSTER_VLM_SYSTEM_PROMPT, userPrompt, imageBase64, ROSTER_VLM_JSON_SCHEMA.schema);
    let parsed: VlmResponse;
    try {
      parsed = JSON.parse(raw) as VlmResponse;
    } catch {
      throw new VisionIngestionError('Ollama vision response was not valid JSON.');
    }
    return mapVlmResponseToResult(parsed, weekStart);
  };

  let result = await runExtraction();

  if (detectedNames.length > 0) {
    const outputNames = namesInResult(result);
    const missing = detectedNames.filter((n) => !outputNames.has(normalizeNameForCompare(n)));
    if (missing.length > 0) {
      console.warn(
        `[parseVisionOllama] Completeness check: ${missing.length} name(s) detected in the image but missing from the extraction (${missing.join(', ')}) — retrying once.`,
      );
      const retryResult = await runExtraction();
      const retryOutputNames = namesInResult(retryResult);
      const stillMissing = detectedNames.filter((n) => !retryOutputNames.has(normalizeNameForCompare(n)));
      if (stillMissing.length > 0) {
        console.warn(
          `[parseVisionOllama] Still missing ${stillMissing.length} name(s) after retry (${stillMissing.join(', ')}) — using the retry result anyway; a manager reviewing the preview will still see whoever's missing isn't on it.`,
        );
      }
      result = retryResult;
    }
  }

  return result;
}
