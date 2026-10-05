import { gridToTsvText } from './parseWorkbook.js';
import { PDFParse } from 'pdf-parse';
import { isOvernight, parseDateCell, parseTimeCell, resolveDayMonthDate } from './normalize.js';
import { getVisionProvider, VisionProviderError, type VisionInput, type VisionOutput, type VisionProvider } from './visionProvider.js';
import { AI_PAUSED_MESSAGE } from '../lib/aiBudget.js';
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
 *  - vision_busy              Gemini answered 429/503 on every retry (quota or overload).
 *  - vision_unconfigured      no Gemini/Vertex credentials on this server.
 *  - vision_model_unavailable every configured model answered 404 (retired, misspelled or not
 *                             offered in the configured region) — an operator fix, not a retry.
 *  - vision_failed            any other failure (auth, bad response, unmappable output).
 *  - vision_paused            the in-app AI spend cap (lib/aiBudget.ts) is reached; nothing was sent.
 */
export type VisionErrorCode = 'vision_busy' | 'vision_unconfigured' | 'vision_model_unavailable' | 'vision_failed' | 'vision_paused';

/**
 * Manager-facing copy. Every message names the way out (Excel/CSV, retry) —
 * and none of them ever comes with data, because the only data a manager
 * should see in the preview is what was read from their own file.
 */
export const VISION_ERROR_MESSAGES: Record<VisionErrorCode, string> = {
  vision_busy: 'AI roster reading is busy right now. Try again in a few minutes, or upload an Excel/CSV export instead.',
  vision_unconfigured: "AI roster reading isn't set up on this server. Upload an Excel/CSV export instead.",
  vision_model_unavailable:
    'AI roster reading is unavailable on this server until its AI model setting is updated. Upload an Excel/CSV export instead, or add staff by hand.',
  vision_failed: "AI roster reading couldn't read this file. Try again in a few minutes, or upload an Excel/CSV export instead.",
  vision_paused: AI_PAUSED_MESSAGE,
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

/** templateLabel of a result the AI reader produced (local fallbacks are labelled 'Deterministic local parser (…)'). */
export const AI_TEMPLATE_LABEL = 'Direct Vision Ingestion';

export interface VisionCallOptions {
  /** Default true (per VLM_FALLBACK_MODE). false: on any AI failure throw the coded VisionIngestionError. */
  localFallback?: boolean;
  /** The venue the read is for — recorded in the AI usage ledger. */
  locationId?: string | null;
}

/** Test seam kept for existing tests: swaps the Gemini SDK client inside the real provider. */
export { __setGeminiClientForTests } from './visionProvider.js';

const PROVIDER_ERROR_CODE: Record<VisionProviderError['kind'], VisionErrorCode> = {
  busy: 'vision_busy',
  model_unavailable: 'vision_model_unavailable',
  failed: 'vision_failed',
  paused: 'vision_paused',
};

/**
 * Runs one provider call. Returns the output, or the VisionErrorCode + cause on a provider
 * failure (the caller decides between a local fallback and an error). Anything that isn't a
 * provider failure (a bug) is rethrown untouched.
 */
async function readWithProvider(
  provider: VisionProvider,
  input: VisionInput,
): Promise<{ output: VisionOutput } | { code: VisionErrorCode; cause: unknown }> {
  try {
    return { output: await provider.readRoster(input) };
  } catch (err) {
    if (err instanceof VisionProviderError) {
      console.error(`[parseVision] ${provider.name} failed (${err.kind}): ${err.message}`, err.cause ?? '');
      return { code: PROVIDER_ERROR_CODE[err.kind], cause: err.cause ?? err };
    }
    throw err;
  }
}

/** Parses + maps the model's JSON. Logs sizes and token counts only — never the roster itself (staff names). */
function mapProviderOutput(output: VisionOutput, provider: VisionProvider, weekStart: string | undefined, startTime: number, what: string): ParsedVisionResult {
  let parsed: VlmResponse;
  try {
    parsed = JSON.parse(output.raw) as VlmResponse;
  } catch {
    throw new VisionIngestionError('Vision model response was not valid JSON.');
  }
  try {
    const result = mapVlmResponseToResult(parsed, weekStart);
    console.log(
      `[parseVision] ${what} read by ${provider.name} model=${output.model} in ${Date.now() - startTime}ms — ` +
        `${output.raw.length} chars, tokens in/out=${output.usage.promptTokens ?? '?'}/${output.usage.outputTokens ?? '?'}, ` +
        `${result.rows.length} shifts, ${result.anomalies.length} anomalies, ${result.leaveRecords.length} leave records.`,
    );
    return result;
  } catch (err) {
    console.error(`[parseVision] Failed to map the ${what} vision response to ShiftSync rows`, err);
    throw new VisionIngestionError(`Failed to map vision response: ${(err as Error).message}`, err);
  }
}

/**
 * Grid-format Excel/CSV ingestion — for rosters that don't match any of the
 * 3 long-format master templates (day-of-week columns, merged section
 * headers, etc), the same layout ShiftSync already handles for images/PDFs.
 * Mirrors parseRosterImage's fallback structure, but sends the
 * already-structured grid as text instead of re-deriving it from pixels.
 * Without AI (unconfigured, busy, failed) the deterministic local parser
 * reads the same grid — still the manager's own data.
 *
 * @param grid  Merge-expanded 2D grid (see buildMergeExpandedGrid).
 * @param options.localFallback  false = never substitute a local parse; throw the coded error
 *   instead (an escalation that already holds its own deterministic result uses this).
 */
export async function parseRosterGrid(
  grid: unknown[][],
  originalFilename: string,
  weekStart?: string,
  options: VisionCallOptions = {},
): Promise<ParsedVisionResult> {
  const startTime = Date.now();
  const mode = options.localFallback === false ? 'off' : fallbackMode();
  const provider = getVisionProvider();

  if (!provider) {
    if (mode === 'off') {
      throw new VisionIngestionError(VISION_ERROR_MESSAGES.vision_unconfigured, undefined, 'vision_unconfigured');
    }
    console.warn('[parseVision] Vision API not configured — using deterministic local fallback for grid-format roster.');
    const result = processRowsIntoRoster(grid, weekStart);
    console.log(
      `[parseVision] Deterministic local parser used in ${Date.now() - startTime}ms (vision API not configured) — ` +
        `${result.rows.length} shifts, ${result.anomalies.length} anomalies.`,
    );
    return { ...result, templateLabel: 'Deterministic local parser (AI roster reading not configured)' };
  }

  const read = await readWithProvider(provider, { kind: 'grid', text: gridToTsvText(grid), originalFilename, weekStart, locationId: options.locationId ?? null });
  if ('code' in read) {
    if (mode === 'off') throw new VisionIngestionError(VISION_ERROR_MESSAGES[read.code], read.cause, read.code);
    console.warn(`[parseVision] Falling back to the deterministic local parser for a grid roster (${read.code}).`);
    const result = processRowsIntoRoster(grid, weekStart);
    return { ...result, templateLabel: `Deterministic local parser (${read.code})` };
  }
  return mapProviderOutput(read.output, provider, weekStart, startTime, 'grid text');
}

export async function parseRosterImage(
  imageBuffer: Buffer,
  mimeType: string,
  originalFilename: string,
  weekStart?: string,
  options: VisionCallOptions = {},
): Promise<ParsedVisionResult> {
  const startTime = Date.now();
  const mode = options.localFallback === false ? 'off' : fallbackMode();
  const provider = getVisionProvider();

  // Not configured. In "auto" mode a text-layer PDF still gets the
  // deterministic local parser; anything else fails with a clear error.
  if (!provider) {
    if (mode === 'off') {
      throw new VisionIngestionError(VISION_ERROR_MESSAGES.vision_unconfigured, undefined, 'vision_unconfigured');
    }
    console.warn('[parseVision] Vision API not configured — trying the deterministic local parser.');
    return buildLocalFallback(imageBuffer, mimeType, weekStart, startTime, 'vision_unconfigured', undefined);
  }

  const read = await readWithProvider(provider, { kind: 'file', data: imageBuffer, mimeType, originalFilename, weekStart, locationId: options.locationId ?? null });
  if ('code' in read) {
    if (mode === 'off') throw new VisionIngestionError(VISION_ERROR_MESSAGES[read.code], read.cause, read.code);
    return buildLocalFallback(imageBuffer, mimeType, weekStart, startTime, read.code, read.cause);
  }
  return mapProviderOutput(read.output, provider, weekStart, startTime, 'image/PDF');
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
    templateLabel: AI_TEMPLATE_LABEL,
    rows: accepted,
    issues,
    anomalies: [...anomalies, ...constraintAnomalies],
    leaveRecords,
    legend: (parsed.legend ?? []).map((l) => ({ code: l.code, meaning: l.meaning })),
  };
}
