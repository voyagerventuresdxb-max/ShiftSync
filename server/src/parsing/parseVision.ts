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

export class VisionIngestionError extends Error {
  /** The underlying error (e.g. a Gemini ApiError) that caused this, if any. */
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VisionIngestionError';
    this.cause = cause;
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
 * Cached sample VLM response used as a deterministic fallback when the live
 * Gemini API is unavailable (429 rate-limit/quota, 503 overload, or no API
 * key). It mirrors the Il Gattopardo roster layout so UI development and
 * testing can continue without hitting live API limits. The rows are routed
 * through the same `mapVlmResponseToResult` mapping as a real model response,
 * so the preview/grid render real data.
 *
 * Override the fallback behavior with VLM_FALLBACK_MODE:
 *   "auto"   (default) — try Gemini, fall back to this sample on 429/503/no-key
 *   "sample"           — always use this sample (skip the network entirely)
 *   "off"              — never fall back; surface the Gemini error
 */
export const FALLBACK_SAMPLE_RESPONSE: VlmResponse = {
  venueTemplateNotes: 'Fallback sample (Gemini unavailable) — Il Gattopardo layout with AM/PM sub-columns.',
  legend: [
    { code: 'AL', meaning: 'Annual Leave', category: 'leave' },
    { code: 'DO', meaning: 'Day Off', category: 'day_off' },
    { code: 'PH', meaning: 'Public Holiday', category: 'public_holiday' },
  ],
  employees: [
    { rawName: 'Andrea', role: 'Manager', cells: [
      { date: '2026-08-17', rawText: '11-17', period: 'AM', interpretation: 'worked_shift', startTime: '11:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
      { date: '2026-08-17', rawText: '18-01', period: 'PM', interpretation: 'worked_shift', startTime: '18:00', endTime: '01:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Roberto', role: 'Manager', cells: [
      { date: '2026-08-17', rawText: '09-17', period: 'AM', interpretation: 'worked_shift', startTime: '09:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Alessandro', role: 'Manager', cells: [
      { date: '2026-08-18', rawText: '10-18', period: 'AM', interpretation: 'worked_shift', startTime: '10:00', endTime: '18:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Tomas', role: 'Manager', cells: [
      { date: '2026-08-18', rawText: 'DO', period: null, interpretation: 'day_off', startTime: null, endTime: null, leaveCode: 'DO', confidence: 0.95, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Sintia', role: 'Supervisor', cells: [
      { date: '2026-08-17', rawText: '12-20', period: 'AM', interpretation: 'worked_shift', startTime: '12:00', endTime: '20:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Pratik', role: 'Supervisor', cells: [
      { date: '2026-08-17', rawText: '14-22', period: 'PM', interpretation: 'worked_shift', startTime: '14:00', endTime: '22:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Rojina', role: 'Head Waiter', cells: [
      { date: '2026-08-17', rawText: '09-17', period: 'AM', interpretation: 'worked_shift', startTime: '09:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Hefny', role: 'Waiter', cells: [
      { date: '2026-08-17', rawText: '10-18', period: 'AM', interpretation: 'worked_shift', startTime: '10:00', endTime: '18:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
      { date: '2026-08-17', rawText: '19-01', period: 'PM', interpretation: 'worked_shift', startTime: '19:00', endTime: '01:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Bashkar', role: 'Runner', cells: [
      { date: '2026-08-17', rawText: '11-19', period: 'AM', interpretation: 'worked_shift', startTime: '11:00', endTime: '19:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
  ],
  documentAnomalies: [],
};

/** Resolve the fallback mode from the VLM_FALLBACK_MODE env var. */
function fallbackMode(): 'auto' | 'sample' | 'off' {
  const mode = (process.env.VLM_FALLBACK_MODE || 'auto').toLowerCase();
  if (mode === 'sample' || mode === 'off') return mode;
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

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) {
    throw new VisionIngestionError('GEMINI_API_KEY is not configured on the server — image/scanned roster ingestion is unavailable.');
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
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

  if (mode === 'sample') {
    console.warn('[parseVision] VLM_FALLBACK_MODE=sample — returning cached sample response (no Gemini call).');
    return buildFallbackResult(weekStart, startTime, 'VLM_FALLBACK_MODE=sample');
  }

  if (!process.env.GEMINI_API_KEY) {
    if (mode === 'off') {
      throw new VisionIngestionError('GEMINI_API_KEY is not configured on the server — grid-format roster ingestion is unavailable.');
    }
    console.warn('[parseVision] GEMINI_API_KEY not configured — using deterministic local fallback for grid-format roster.');
    const result = processRowsIntoRoster(grid, weekStart);
    console.log(
      `[parseVision] Deterministic local parser used in ${Date.now() - startTime}ms (GEMINI_API_KEY not configured) — ` +
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

  // "sample" mode: skip the network entirely and return the cached sample so
  // UI development/testing never touches the live API.
  if (mode === 'sample') {
    console.warn('[parseVision] VLM_FALLBACK_MODE=sample — returning cached sample response (no Gemini call).');
    return buildFallbackResult(weekStart, startTime, 'VLM_FALLBACK_MODE=sample');
  }

  // No API key configured. In "auto" mode, fall back to the deterministic
  // local parser (for PDFs) or the cached sample (for images) so the upload
  // flow still works for UI development; in "off" mode, surface the error.
  if (!process.env.GEMINI_API_KEY) {
    if (mode === 'off') {
      throw new VisionIngestionError('GEMINI_API_KEY is not configured on the server — image/scanned roster ingestion is unavailable.');
    }
    console.warn('[parseVision] GEMINI_API_KEY not configured — using deterministic local fallback.');
    return buildLocalFallback(imageBuffer, mimeType, weekStart, startTime, 'GEMINI_API_KEY not configured');
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
      // point retrying. In "auto" mode, still fall back to the sample so the
      // upload flow doesn't hard-fail during development; in "off" mode,
      // surface it immediately.
      console.error('[parseVision] Gemini request failed', err);
      if (mode === 'off') {
        throw new VisionIngestionError(`Vision model request failed: ${(err as Error).message}`, err);
      }
      console.warn('[parseVision] Falling back to deterministic local parser after non-transient Gemini error.');
      return buildLocalFallback(imageBuffer, mimeType, weekStart, startTime, `Gemini error: ${(err as Error).message}`);
    }
  }

  if (raw === null) {
    // All attempts exhausted on 503/429s.
    console.error('[parseVision] Gemini request failed after retries', lastError);
    if (mode === 'off') {
      throw new VisionIngestionError(
        `Vision model request failed after retries: ${(lastError as Error)?.message ?? 'unknown error'}`,
        lastError,
      );
    }
    console.warn('[parseVision] Falling back to deterministic local parser after retries exhausted.');
    return buildLocalFallback(imageBuffer, mimeType, weekStart, startTime, `Gemini rate limit/overload: ${(lastError as Error)?.message ?? 'unknown error'}`);
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
 * Builds a ParsedVisionResult from the cached sample response, routed through
 * the same mapping as a real model response. `reason` is surfaced in the
 * template label so the UI/manager can see the data is a fallback sample.
 */
function buildFallbackResult(
  weekStart: string | undefined,
  startTime: number,
  reason: string,
): ParsedVisionResult {
  const result = mapVlmResponseToResult(FALLBACK_SAMPLE_RESPONSE, weekStart);
  console.log(
    `[parseVision] Fallback sample used in ${Date.now() - startTime}ms (${reason}) — ` +
      `${result.rows.length} shifts, ${result.anomalies.length} anomalies, ${result.leaveRecords.length} leave records.`
  );
  return {
    ...result,
    templateLabel: `Fallback sample (${reason})`,
  };
}

/**
 * Builds a fallback result when the live Gemini API is unavailable. For PDFs
 * (which may carry an extractable text layer) it runs the deterministic local
 * parser so the uploaded file is actually parsed rather than replaced with
 * sample data. For raster images (which have no text layer to parse locally)
 * it falls back to the cached sample response.
 */
async function buildLocalFallback(
  imageBuffer: Buffer,
  mimeType: string,
  weekStart: string | undefined,
  startTime: number,
  reason: string,
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
          `[parseVision] Deterministic local parser used in ${Date.now() - startTime}ms (${reason}) — ` +
            `${result.rows.length} shifts, ${result.anomalies.length} anomalies.`
        );
        return {
          ...result,
          templateLabel: `Deterministic local parser (${reason})`,
        };
      }
    } catch (err) {
      console.warn('[parseVision] Deterministic PDF fallback failed, using cached sample:', err);
    }
  }
  // Images (or PDFs with no text layer) — no local parse possible; use sample.
  return buildFallbackResult(weekStart, startTime, reason);
}

/** Pure mapping function (no network calls) — kept separate so it's unit-testable against fixture JSON. */
export function mapVlmResponseToResult(parsed: VlmResponse, weekStart?: string): ParsedVisionResult {
  const rows: ParsedShiftRow[] = [];
  const issues: RowIssue[] = [];
  const anomalies: AnomalyRecord[] = [];
  const leaveRecords: LeaveRecord[] = [];

  let rowNumber = 1;

  for (const employee of parsed.employees ?? []) {
    const employeeName = (employee.rawName ?? '').trim();
    const roleName = (employee.role ?? '').trim();

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
