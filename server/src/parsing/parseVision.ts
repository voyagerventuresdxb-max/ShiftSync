import { GoogleGenAI, ApiError } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import { isOvernight, parseDateCell, parseTimeCell, resolveDayMonthDate } from './normalize.js';
import { ROSTER_VLM_GEMINI_SCHEMA, ROSTER_VLM_SYSTEM_PROMPT } from './vlmPrompt.js';
import { enforceNoDoubleShifts } from './shiftConstraints.js';
import { parseRotaFile, processRowsIntoRoster } from './deterministicParser.js';
import type { AnomalyRecord, LeaveRecord, ParsedShiftRow, ParsedVisionResult, RowIssue } from './types.js';

/**
 * Below this confidence a resolved cell still gets flagged for manager review
 * (routed to `anomalies`) rather than being accepted as a workable row. Kept
 * deliberately lenient so a valid shift with a slightly unusual code or
 * formatting is still surfaced to the manager instead of silently dropped.
 */
const REVIEW_CONFIDENCE_THRESHOLD = 0.4;

const CONFIDENCE_CLAMP = { min: 0, max: 1 };

function clampConfidence(value: number): number {
  return Math.min(CONFIDENCE_CLAMP.max, Math.max(CONFIDENCE_CLAMP.min, value));
}

/**
 * Why AI roster reading produced no result — surfaced to the client as
 * `errorCode` beside the message so a quota problem can be told apart from
 * a bug without reading server logs:
 *  - vision_busy         Gemini answered 429/503 on every retry (quota or overload).
 *  - vision_unconfigured no Gemini/Vertex credentials on this server.
 *  - vision_failed       any other failure (auth, bad response, unmappable output).
 */
export type VisionErrorCode = 'vision_busy' | 'vision_unconfigured' | 'vision_failed';

/**
 * Manager-facing copy. Every message names the way out (Excel/CSV, retry) —
 * and none of them ever comes with data, because the only data a manager
 * should see in the preview is what was read from their own file.
 */
export const VISION_ERROR_MESSAGES: Record<VisionErrorCode, string> = {
  vision_busy: 'AI roster reading is busy right now. Try again in a few minutes, or upload an Excel/CSV export instead.',
  vision_unconfigured: "AI roster reading isn't set up on this server. Upload an Excel/CSV export instead.",
  vision_failed: "AI roster reading couldn't read this file. Try again in a few minutes, or upload an Excel/CSV export instead.",
};

export class VisionIngestionError extends Error {
  /** The underlying error (e.g. a Gemini ApiError) that caused this, if any. */
  cause?: unknown;
  /** Machine-readable reason; the upload route returns it as `errorCode`. */
  code: VisionErrorCode;

  constructor(message: string, cause?: unknown, code: VisionErrorCode = 'vision_failed') {
    super(message);
    this.name = 'VisionIngestionError';
    this.cause = cause;
    this.code = code;
    // Preserve the original stack so the server log shows the real failure
    // point instead of only the wrapper's message.
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

// --- Raw shape returned by the VLM, mirroring ROSTER_VLM_JSON_SCHEMA ---
interface VlmCell {
  date: string;
  rawText: string;
  period: 'AM' | 'PM' | null;
  interpretation: 'worked_shift' | 'leave' | 'day_off' | 'public_holiday' | 'unresolved';
  startTime: string | null;
  endTime: string | null;
  leaveCode: string | null;
  confidence: number;
  needsReview: boolean;
  reviewReason: string | null;
}
interface VlmEmployee {
  rawName: string;
  role: string | null;
  cells: VlmCell[];
}
export interface VlmResponse {
  venueTemplateNotes: string;
  legend: { code: string; meaning: string; category: string }[];
  employees: VlmEmployee[];
  documentAnomalies: { location: string; rawText: string; reason: string }[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What happens when the live Gemini API can't be used (no credentials, a
 * 429 quota/rate limit, a 503 overload, any other failure):
 *
 *  - a PDF that carries a text layer is parsed by the deterministic local
 *    parser — that is still the manager's own file, just read without AI;
 *  - a raster image, or a PDF with no text layer, FAILS with a
 *    VisionIngestionError whose `code` says why (see VisionErrorCode).
 *
 * There is deliberately no canned sample roster any more. One used to live
 * here and was returned to real managers whenever Gemini was rate-limited —
 * a roster full of strangers, labelled only in a field the UI never showed.
 * The old sample survives solely as a test fixture
 * (__fixtures__/sampleVlmResponse.fixture.ts) for mapVlmResponseToResult.
 *
 * VLM_FALLBACK_MODE:
 *   "auto" (default) — the behaviour above.
 *   "off"            — never even try the local PDF parse; surface the error.
 *   "sample"         — REMOVED. Logged and treated as "auto".
 */
function fallbackMode(): 'auto' | 'off' {
  const mode = (process.env.VLM_FALLBACK_MODE || 'auto').toLowerCase();
  if (mode === 'off') return 'off';
  if (mode === 'sample') {
    console.warn('[parseVision] VLM_FALLBACK_MODE=sample no longer exists (the sample roster was removed from production); behaving as "auto".');
  }
  return 'auto';
}

/**
 * Normalises a Gemini `interpretation` value to the canonical enum. The model
 * occasionally returns variations ("worked shift", "Worked_Shift", "dayoff",
 * "public holiday") — map them to the exact values the rest of the pipeline
 * expects so a valid cell isn't silently dropped.
 */
function normalizeInterpretation(value: unknown): VlmCell['interpretation'] {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (raw) {
    case 'worked_shift':
    case 'worked':
    case 'shift':
    case 'work':
      return 'worked_shift';
    case 'leave':
    case 'annual_leave':
    case 'al':
    case 'sick':
    case 'sick_leave':
    case 'sl':
    case 'training':
    case 'tr':
      return 'leave';
    case 'day_off':
    case 'dayoff':
    case 'off':
    case 'rest_day':
    case 'rest':
    case 'do':
      return 'day_off';
    case 'public_holiday':
    case 'public_holiday_leave':
    case 'holiday':
    case 'ph':
      return 'public_holiday';
    case 'unresolved':
    case 'unknown':
    case 'unclear':
    case 'ambiguous':
      return 'unresolved';
    default:
      return 'unresolved';
  }
}

// Hosted vision API timeout — a normal cloud API call, not the local Ollama
// path's 600s+ budget (a partial-GPU-offload local model could take 18+
// minutes; a hosted API call that hasn't responded in well under a minute
// is a genuine failure, not "still thinking"). Overridable for slow
// networks, but the default reflects a real hosted-API request, not a
// local-inference one.
const GEMINI_HTTP_TIMEOUT_MS = Number(process.env.GEMINI_HTTP_TIMEOUT_MS) || 30_000;

/**
 * True once either Vertex AI (GEMINI_VERTEX_PROJECT) or the Gemini
 * Developer API (GEMINI_API_KEY) is configured — callers use this instead
 * of checking GEMINI_API_KEY directly so a Vertex-only deployment isn't
 * mistaken for "not configured" and routed to the local/sample fallback.
 */
function isGeminiConfigured(): boolean {
  return !!(process.env.GEMINI_VERTEX_PROJECT || process.env.GEMINI_API_KEY);
}

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (client) return client;

  // Vertex AI (preferred for production — EU-region-pinned, billed to a
  // GCP project, authenticated via Application Default Credentials rather
  // than a bearer API key) when GEMINI_VERTEX_PROJECT is set. Location
  // defaults to europe-west4 (the project's chosen EU region — see
  // docs/gcp-vertex-setup.md) so a deployment only needs to set the
  // project id; override GEMINI_VERTEX_LOCATION explicitly for a
  // different EU region.
  const project = process.env.GEMINI_VERTEX_PROJECT;
  if (project) {
    const location = process.env.GEMINI_VERTEX_LOCATION || 'europe-west4';
    // Auth is handled by google-auth-library's Application Default
    // Credentials (a service account key file via GOOGLE_APPLICATION_CREDENTIALS,
    // or workload identity in a GCP-hosted deployment) — no key material
    // passed here by design; see GoogleGenAIOptions.googleAuthOptions if a
    // non-default credential source is ever needed.
    client = new GoogleGenAI({ vertexai: true, project, location, httpOptions: { timeout: GEMINI_HTTP_TIMEOUT_MS } });
    return client;
  }

  // Gemini Developer API (AI Studio) fallback — dev/test convenience, not
  // the EU-data-residency-pinned production path.
  if (!process.env.GEMINI_API_KEY) {
    throw new VisionIngestionError(
      'Neither GEMINI_VERTEX_PROJECT (Vertex AI) nor GEMINI_API_KEY (Gemini Developer API) is configured on the server — image/scanned roster ingestion is unavailable.',
    );
  }
  client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: GEMINI_HTTP_TIMEOUT_MS } });
  return client;
}

/**
 * Test seam: swaps the memoized Gemini client so a 429/503 can be simulated
 * without a network call (see parseVisionFallback.test.ts). Pass null to
 * restore lazy creation. Never called from production code.
 */
export function __setGeminiClientForTests(fake: GoogleGenAI | null): void {
  client = fake;
}

/**
 * Sends a roster image (or scanned PDF) to the configured Gemini vision
 * model and maps the structured response into ShiftSync's canonical
 * row/issue contracts.
 *
 * @param imageBuffer  Raw image bytes (png/jpeg/webp) or PDF bytes.
 * @param mimeType     e.g. "image/png" or "application/pdf".
 * @param originalFilename  For error messages only.
 */
/**
 * True when a Gemini error is transient and worth retrying: a 503 "high
 * demand" overload, or a 429 rate-limit/quota error ("You exceeded your
 * current quota..."). Both are temporary and may clear on a later attempt.
 */
function isTransientOverload(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 503 || err.status === 429);
}

/** Sleep helper for the backoff retry wrapper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a single Gemini generateContent call for the given model and returns
 * the raw text. Throws on failure (caller handles retry/fallback).
 */
async function callGemini(
  genai: GoogleGenAI,
  model: string,
  imageBuffer: Buffer,
  mimeType: string,
  originalFilename: string,
  weekStart?: string,
): Promise<string> {
  const referenceWeek = weekStart
    ? ` The current active roster week starts on ${weekStart} (ISO Sunday). Use this as the reference week to resolve day-month dates and to anchor the week's date range.`
    : '';
  const response = await genai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Roster image filename: "${originalFilename}". Extract it per the schema.${referenceWeek}`,
          },
          {
            inlineData: {
              mimeType,
              data: imageBuffer.toString('base64'),
            },
          },
        ],
      },
    ],
    config: {
      systemInstruction: ROSTER_VLM_SYSTEM_PROMPT,
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: ROSTER_VLM_GEMINI_SCHEMA,
    },
  });

  const raw = response?.text;
  if (!raw) {
    throw new VisionIngestionError('Vision model returned an empty response.');
  }
  return raw;
}

/**
 * Same as callGemini, but for a spreadsheet grid that couldn't be matched to
 * one of the 3 long-format templates (day-columns/merged-headers layout).
 * Sends the merge-expanded grid as a plain-text table instead of image bytes
 * — Gemini reads it with the exact same spatial-reasoning system prompt used
 * for images, since the prompt's instructions are about grid structure, not
 * pixels.
 */
async function callGeminiWithGridText(
  genai: GoogleGenAI,
  model: string,
  gridText: string,
  originalFilename: string,
  weekStart?: string,
): Promise<string> {
  const referenceWeek = weekStart
    ? ` The current active roster week starts on ${weekStart} (ISO Sunday). Use this as the reference week to resolve day-month dates and to anchor the week's date range.`
    : '';
  const response = await genai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `Roster spreadsheet filename: "${originalFilename}". This roster did not match any of ` +
              `ShiftSync's known long-format column templates, so it is being read as a raw grid instead. ` +
              `Below is the sheet's cell grid as plain text: each line is one spreadsheet row, cells within ` +
              `a row are separated by a tab character. Merged cells have already been expanded so every ` +
              `covered cell repeats the merged value. Analyze this exactly as you would a photographed/` +
              `screenshotted roster image — apply the same spatial grid analysis to the row/column layout of ` +
              `this text. Extract it per the schema.${referenceWeek}\n\n${gridText}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: ROSTER_VLM_SYSTEM_PROMPT,
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: ROSTER_VLM_GEMINI_SCHEMA,
    },
  });

  const raw = response?.text;
  if (!raw) {
    throw new VisionIngestionError('Vision model returned an empty response.');
  }
  return raw;
}

/**
 * Grid-format Excel/CSV ingestion — for rosters that don't match any of the
 * 3 long-format master templates (day-of-week columns, merged section
 * headers, etc), the same layout ShiftSync already handles for images/PDFs.
 * Mirrors parseRosterImage's retry/fallback structure, but sends the
 * already-structured grid as text instead of re-deriving it from pixels.
 *
 * @param grid  Merge-expanded 2D grid (see buildMergeExpandedGrid).
 */
export async function parseRosterGrid(
  grid: unknown[][],
  originalFilename: string,
  weekStart?: string,
): Promise<ParsedVisionResult> {
  const startTime = Date.now();
  const mode = fallbackMode();
  const gridText = grid
    .map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))).join('\t'))
    .join('\n');

  if (!isGeminiConfigured()) {
    if (mode === 'off') {
      throw new VisionIngestionError(VISION_ERROR_MESSAGES.vision_unconfigured, undefined, 'vision_unconfigured');
    }
    console.warn('[parseVision] Vision API not configured — using deterministic local fallback for grid-format roster.');
    const result = processRowsIntoRoster(grid, weekStart);
    console.log(
      `[parseVision] Deterministic local parser used in ${Date.now() - startTime}ms (vision API not configured) — ` +
        `${result.rows.length} shifts, ${result.anomalies.length} anomalies.`,
    );
    return { ...result, templateLabel: 'Deterministic local parser (GEMINI_API_KEY not configured)' };
  }

  const genai = getClient();
  const primaryModel = process.env.VLM_MODEL || 'gemini-3.6-flash';
  const fallbackModel = process.env.VLM_FALLBACK_MODEL || 'gemini-3.5-flash-lite';

  const attempts: { model: string; delayMs: number }[] = [
    { model: primaryModel, delayMs: 0 },
    { model: fallbackModel, delayMs: 1000 },
    { model: fallbackModel, delayMs: 2000 },
  ];

  let lastError: unknown;
  let raw: string | null = null;

  for (const attempt of attempts) {
    if (attempt.delayMs > 0) await sleep(attempt.delayMs);
    try {
      raw = await callGeminiWithGridText(genai, attempt.model, gridText, originalFilename, weekStart);
      break;
    } catch (err) {
      lastError = err;
      if (isTransientOverload(err)) {
        const status = err instanceof ApiError ? err.status : '?';
        console.warn(
          `[parseVision] Gemini model "${attempt.model}" returned ${status} on grid text; ` +
            `retrying with "${attempts[Math.min(attempts.indexOf(attempt) + 1, attempts.length - 1)].model}" after ${attempt.delayMs}ms.`,
        );
        continue;
      }
      console.error('[parseVision] Gemini grid-text request failed', err);
      if (mode === 'off') {
        throw new VisionIngestionError(`Vision model request failed: ${(err as Error).message}`, err);
      }
      console.warn('[parseVision] Falling back to deterministic local parser after non-transient Gemini error (grid text).');
      const result = processRowsIntoRoster(grid, weekStart);
      return { ...result, templateLabel: `Deterministic local parser (Gemini error: ${(err as Error).message})` };
    }
  }

  if (raw === null) {
    console.error('[parseVision] Gemini grid-text request failed after retries', lastError);
    if (mode === 'off') {
      throw new VisionIngestionError(
        `Vision model request failed after retries: ${(lastError as Error)?.message ?? 'unknown error'}`,
        lastError,
      );
    }
    console.warn('[parseVision] Falling back to deterministic local parser after retries exhausted (grid text).');
    const result = processRowsIntoRoster(grid, weekStart);
    return { ...result, templateLabel: `Deterministic local parser (Gemini rate limit/overload)` };
  }

  let parsed: VlmResponse;
  try {
    parsed = JSON.parse(raw) as VlmResponse;
  } catch {
    throw new VisionIngestionError('Vision model response was not valid JSON.');
  }

  console.log('[parseVision] raw Gemini JSON (grid text):', raw);

  try {
    const result = mapVlmResponseToResult(parsed, weekStart);
    console.log(
      `[parseVision] Grid-text vision ingestion complete in ${Date.now() - startTime}ms — ` +
        `${result.rows.length} shifts, ${result.anomalies.length} anomalies, ${result.leaveRecords.length} leave records.`,
    );
    return result;
  } catch (err) {
    console.error('[parseVision] Failed to map Gemini grid-text response to ShiftSync rows', err);
    throw new VisionIngestionError(`Failed to map vision response: ${(err as Error).message}`, err);
  }
}

export async function parseRosterImage(
  imageBuffer: Buffer,
  mimeType: string,
  originalFilename: string,
  weekStart?: string,
): Promise<ParsedVisionResult> {
  const startTime = Date.now();
  const mode = fallbackMode();

  // No API key configured. In "auto" mode a text-layer PDF still gets the
  // deterministic local parser; anything else fails with a clear error.
  if (!isGeminiConfigured()) {
    if (mode === 'off') {
      throw new VisionIngestionError(VISION_ERROR_MESSAGES.vision_unconfigured, undefined, 'vision_unconfigured');
    }
    console.warn('[parseVision] Vision API not configured — trying the deterministic local parser.');
    return buildLocalFallback(imageBuffer, mimeType, weekStart, startTime, 'vision_unconfigured', undefined);
  }

  const genai = getClient();
  const primaryModel = process.env.VLM_MODEL || 'gemini-3.6-flash';
  const fallbackModel = process.env.VLM_FALLBACK_MODEL || 'gemini-3.5-flash-lite';

  // Attempt 1: primary model. On a transient 503/429, back off and retry with
  // the fallback model (up to 2 retries, exponential 1s -> 2s delay) so
  // temporary high-demand spikes or rate limits don't fail the user's upload.
  const attempts: { model: string; delayMs: number }[] = [
    { model: primaryModel, delayMs: 0 },
    { model: fallbackModel, delayMs: 1000 },
    { model: fallbackModel, delayMs: 2000 },
  ];

  let lastError: unknown;
  let raw: string | null = null;

  for (const attempt of attempts) {
    if (attempt.delayMs > 0) await sleep(attempt.delayMs);
    try {
      raw = await callGemini(genai, attempt.model, imageBuffer, mimeType, originalFilename, weekStart);
      break;
    } catch (err) {
      lastError = err;
      if (isTransientOverload(err)) {
        const status = err instanceof ApiError ? err.status : '?';
        console.warn(
          `[parseVision] Gemini model "${attempt.model}" returned ${status} (${status === 429 ? 'rate limit/quota' : 'high demand'}); ` +
            `retrying with "${attempts[Math.min(attempts.indexOf(attempt) + 1, attempts.length - 1)].model}" after ${attempt.delayMs}ms.`,
        );
        continue;
      }
      // Non-transient error (auth, invalid model, schema rejection, etc.) — no
      // point retrying. In "auto" mode a text-layer PDF still gets the local
      // parser; in "off" mode, surface it immediately.
      console.error('[parseVision] Gemini request failed', err);
      if (mode === 'off') {
        throw new VisionIngestionError(VISION_ERROR_MESSAGES.vision_failed, err, 'vision_failed');
      }
      return buildLocalFallback(imageBuffer, mimeType, weekStart, startTime, 'vision_failed', err);
    }
  }

  if (raw === null) {
    // All attempts exhausted on 503/429s — quota or overload, not a bug.
    console.error('[parseVision] Gemini request failed after retries (rate limit/overload)', lastError);
    if (mode === 'off') {
      throw new VisionIngestionError(VISION_ERROR_MESSAGES.vision_busy, lastError, 'vision_busy');
    }
    return buildLocalFallback(imageBuffer, mimeType, weekStart, startTime, 'vision_busy', lastError);
  }

  let parsed: VlmResponse;
  try {
    parsed = JSON.parse(raw) as VlmResponse;
  } catch {
    throw new VisionIngestionError('Vision model response was not valid JSON.');
  }

  // Log the raw model output so we can inspect how Gemini is structuring its
  // response (field names, nesting, interpretation values) when debugging
  // why rows are being dropped or mis-routed.
  console.log('[parseVision] raw Gemini JSON:', raw);

  try {
    const result = mapVlmResponseToResult(parsed, weekStart);
    console.log(
      `[parseVision] Direct vision ingestion complete in ${Date.now() - startTime}ms — ` +
        `${result.rows.length} shifts, ${result.anomalies.length} anomalies, ${result.leaveRecords.length} leave records.`
    );
    return result;
  } catch (err) {
    console.error('[parseVision] Failed to map Gemini response to ShiftSync rows', err);
    throw new VisionIngestionError(`Failed to map vision response: ${(err as Error).message}`, err);
  }
}


/**
 * What to do with the manager's file when the live Gemini API can't be
 * used. A PDF that carries an extractable text layer is run through the
 * deterministic local parser — still the manager's own data, just read
 * without AI. A raster image, or a PDF with no text layer, has nothing to
 * parse locally, so this FAILS with the code the caller passed in: never
 * placeholder data.
 */
async function buildLocalFallback(
  imageBuffer: Buffer,
  mimeType: string,
  weekStart: string | undefined,
  startTime: number,
  code: VisionErrorCode,
  cause: unknown,
): Promise<ParsedVisionResult> {
  const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(mimeType);
  if (isPdf) {
    try {
      const parser = new PDFParse({ data: imageBuffer });
      let text: string | null = null;
      try {
        const result = await parser.getText();
        text = (result?.text ?? '').trim() || null;
      } finally {
        await parser.destroy();
      }
      if (text) {
        const result = parseRotaFile(text, 'pdf-text', weekStart);
        console.log(
          `[parseVision] Deterministic local parser used in ${Date.now() - startTime}ms (${code}) — ` +
            `${result.rows.length} shifts, ${result.anomalies.length} anomalies.`
        );
        return {
          ...result,
          templateLabel: `Deterministic local parser (${code})`,
        };
      }
    } catch (err) {
      console.warn('[parseVision] Deterministic PDF fallback failed:', err);
    }
  }
  // Images (or PDFs with no text layer) — nothing to parse locally. Fail
  // clearly rather than show anything that didn't come from this file.
  throw new VisionIngestionError(VISION_ERROR_MESSAGES[code], cause, code);
}

/** Pure mapping function (no network calls) — kept separate so it's unit-testable against fixture JSON. */
export function mapVlmResponseToResult(parsed: VlmResponse, weekStart?: string): ParsedVisionResult {
  const rows: ParsedShiftRow[] = [];
  const issues: RowIssue[] = [];
  const anomalies: AnomalyRecord[] = [];
  const leaveRecords: LeaveRecord[] = [];

  let rowNumber = 1;
  // One value per detected employee block, shared by every shift pushed for
  // that employee — unlike `rowNumber` (a per-SHIFT counter) — so a
  // consumer can group shifts by the actual employee record instead of by
  // name alone. See ParsedShiftRow.sourceRowIndex's own doc comment.
  let sourceRowIndex = 0;

  for (const employee of parsed.employees ?? []) {
    const employeeName = (employee.rawName ?? '').trim();
    const roleName = (employee.role ?? '').trim();
    const currentSourceRowIndex = sourceRowIndex++;

    for (const cell of employee.cells ?? []) {
      const confidence = clampConfidence(cell.confidence ?? 0);
      const interpretation = normalizeInterpretation(cell.interpretation);
      // Normalise the date/time with the same lenient helpers the Excel/PDF
      // paths use, so "14/07/2026", "9:00", "17:00:00" etc. are accepted
      // rather than rejected for not being strict ISO/HH:mm. Gemini often
      // returns day-month dates without a year ("18-Aug") — resolve those
      // against the roster week when one is known.
      const isoDate =
        parseDateCell(cell.date ?? '') ??
        (ISO_DATE_RE.test(cell.date ?? '') ? cell.date : null) ??
        (weekStart ? resolveDayMonthDate(cell.date, weekStart) : null);
      const isDateResolved = !!isoDate;

      // Anything the model itself couldn't place, or dated it couldn't
      // resolve to a real calendar date, or dated but under our own
      // confidence floor — flag for manager review instead of guessing.
      if (
        interpretation === 'unresolved' ||
        !isDateResolved ||
        confidence < REVIEW_CONFIDENCE_THRESHOLD ||
        !employeeName
      ) {
        anomalies.push({
          employeeName: employeeName || null,
          date: isDateResolved ? isoDate : null,
          rawText: cell.rawText ?? '(blank)',
          reason:
            cell.reviewReason ??
            (!isDateResolved
              ? `Could not resolve a calendar date for raw label "${cell.date}".`
              : !employeeName
                ? 'Row has no resolvable employee name.'
                : `Below confidence threshold (${confidence.toFixed(2)}).`),
          confidence,
          rowNumber: null,
        });
        continue;
      }

      if (interpretation === 'leave' || interpretation === 'day_off' || interpretation === 'public_holiday') {
        leaveRecords.push({
          employeeName,
          date: isoDate!,
          leaveCode: cell.leaveCode ?? cell.rawText,
          category: interpretation,
        });
        continue;
      }

      // worked_shift. A missing role is surfaced as a warning, not dropped —
      // the row still flows through to DB resolution so it lands in the
      // "Unmatched role" review queue where a manager can assign one,
      // instead of silently disappearing before the manager ever sees it.
      if (!roleName) {
        issues.push({
          rowNumber,
          field: 'role',
          severity: 'warning',
          message: `No role/position could be identified for "${employeeName}" on ${isoDate} — flagged for manual role assignment.`,
        });
      }
      const startTime = parseTimeCell(cell.startTime ?? '');
      const endTime = parseTimeCell(cell.endTime ?? '');

      if (!startTime || !endTime) {
        anomalies.push({
          employeeName,
          date: isoDate,
          rawText: cell.rawText,
          reason: cell.reviewReason ?? `Shift time could not be fully resolved (start=${cell.startTime ?? 'null'}, end=${cell.endTime ?? 'null'}).`,
          confidence,
          rowNumber: null,
        });
        continue;
      }

      if (cell.needsReview) {
        anomalies.push({
          employeeName,
          date: isoDate,
          rawText: cell.rawText,
          reason: cell.reviewReason ?? 'Model flagged this cell for manual confirmation.',
          confidence,
          // This cell still produces a row below (rowNumber not yet
          // incremented) — link the anomaly to it so the Confirm UI can
          // join anomalies onto PreviewRows by rowNumber at render time.
          rowNumber,
        });
        // Still emit the row below — a flagged-but-resolved shift is safer
        // to show in the preview (where the manager can edit/reject it)
        // than to drop silently.
      }

      rows.push({
        rowNumber: rowNumber++,
        sourceRowIndex: currentSourceRowIndex,
        employeeName,
        roleName,
        date: isoDate!,
        startTime,
        endTime,
        overnight: isOvernight(startTime, endTime),
        breakMinutes: 0,
        // Preserve the AM/PM sub-column label so the split-shift constraint
        // and the preview can keep the two blocks distinct. Prefix it into
        // managerNotes (the only free-text field on ParsedShiftRow) so it
        // survives role/user resolution and shows in the manager preview.
        managerNotes: [
          cell.period ? `[${cell.period}]` : null,
          cell.needsReview ? `Auto-extracted from image — please confirm ("${cell.rawText}").` : null,
        ]
          .filter(Boolean)
          .join(' ') || null,
      });
    }
  }

  for (const docAnomaly of parsed.documentAnomalies ?? []) {
    anomalies.push({
      employeeName: null,
      date: null,
      rawText: docAnomaly.rawText,
      reason: `${docAnomaly.location}: ${docAnomaly.reason}`,
      confidence: 0,
      rowNumber: null,
    });
  }

  // Hard code-level backstop (never rely on the model's prompt-following
  // alone): max 1 shift per employee per day, or 2 non-overlapping shifts
  // with a real break (AM+PM split). Anything beyond that — the classic
  // "one printed cell got split into 3+ rows" hallucination pattern that
  // inflates a ~40-shift roster into 85+ — is stripped out of `rows` and
  // routed to `anomalies` for manual review instead of silently accepted.
  const { accepted, anomalies: constraintAnomalies } = enforceNoDoubleShifts(rows);

  return {
    templateLabel: 'Direct Vision Ingestion',
    rows: accepted,
    issues,
    anomalies: [...anomalies, ...constraintAnomalies],
    leaveRecords,
    legend: (parsed.legend ?? []).map((l) => ({ code: l.code, meaning: l.meaning })),
  };
}
