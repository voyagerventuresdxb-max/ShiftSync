/**
 * How POST /api/schedules/upload reads a roster file — every decision except HTTP itself, so
 * the route and the eval harness (server/eval/roster) run exactly the same path.
 *
 *  - Spreadsheets (XLSX/CSV) are read deterministically. The AI reader is asked (with the
 *    manager's consent) only when the built-in reader can't be trusted: an unrecognised layout,
 *    proven dropped data, an ALL-CAPS venue, many empty roles, rows it couldn't read, or nobody.
 *  - Text-layer PDFs: the AI reader is the primary reader and the table reader cross-checks it
 *    (rosterReading.ts). Without consent, or with the AI unavailable/paused/out of allowance,
 *    the table reader's result stands on its own.
 *  - Photos and image-only PDFs: the AI reader only (a scan sidecar first, when one runs).
 * Each file's AI reading is cached per venue: a re-upload costs nothing.
 * Every result carries the people read, rows left unread, the printed week and a reading report.
 */
import { PDFParse } from 'pdf-parse';
import { buildMergeExpandedGrid, listOtherSheetNames, parseWorkbookBuffer, TemplateDetectionError } from './parseWorkbook.js';
import { parseExcelGrid, RosterExtractionAnomalyError } from './deterministicGridParser.js';
import { extractPdfTable, hasPdfTextLayer, pdfPageCount } from './pdfTableExtractor.js';
import { parseRosterText } from './parseText.js';
import { processRowsIntoRoster } from './deterministicParser.js';
import { gridToTsvText } from './parseWorkbook.js';
import { VISION_ERROR_MESSAGES, visionErrorMessage, type VisionErrorCode } from './parseVision.js';
import { VisionProviderError, type VisionProvider } from './visionProvider.js';
import { deterministicEscalationReason, ESCALATION_REASON_TEXT, type EscalationReason } from './escalation.js';
import { parseScannedPdfViaDocling, DoclingUnavailableError } from './doclingClient.js';
import { aiReadRoster, aiResult, peopleFromRows, reconcileReadings, shortPagesOf, withPersonKeys, type AiReadOutcome, type AiReadSource } from './rosterReading.js';
import { mapReadingAnswer } from './aiReading.js';
import { aiCrossRead, crossCheckAiReadings } from './aiCrossCheck.js';
import type { ReadingAnswer } from './vlmPrompt.js';
import { fileSha256, type ReadingCache } from './readingCache.js';
import { addDays, detectWeek, mondayOfIso } from './weekDetection.js';
import type { ReadingReport, WeekDetection } from './rosterContract.js';
import type { AnomalyRecord, ParsedVisionResult } from './types.js';

/** The manual path, named wherever AI reading can't help. */
export const MANUAL_PATH = 'You can also add staff by hand: People → Add staff member.';
export const AI_CONSENT_MESSAGE =
  'To read it, ShiftSync needs to send the file to its AI reader, a third-party service outside the UAE. Nothing is sent unless you agree.';

export function withManualPath(message: string): string {
  return /by hand/i.test(message) ? message : `${message} ${MANUAL_PATH}`;
}

/** What happened to an escalation; returned on the preview so the review screen can say so. */
export interface EscalationOutcome {
  reason: EscalationReason;
  status: 'used' | 'needs_consent' | 'unavailable';
  message: string;
}

export interface UploadFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface UploadReadContext {
  /** The venue (null only for the offline eval: nothing is recorded against a venue). */
  locationId: string | null;
  userId: string | null;
  /** Today in the venue's timezone (YYYY-MM-DD). */
  today: string;
  /** The Monday the client sent, used only when the roster prints no dates. */
  clientWeekStart: string | null;
  aiConsent: boolean;
  provider: VisionProvider | null;
  /** A user-facing reason the AI reader may not run for this file (size, weekly allowance), else null. */
  aiBlockedReason: () => Promise<string | null>;
  /** Records one use of the venue's AI allowance; called once, only after the AI answered. */
  markAiUsed: () => Promise<void>;
  cache: ReadingCache | null;
  /** Latest moment (epoch ms) any AI call of this upload may still run. */
  deadline: number;
  /** Test seam (see schedules.ts __setGridParserForTests). */
  gridParser?: typeof parseExcelGrid;
}

export type UploadReadOutcome =
  | { ok: true; result: ParsedVisionResult & { week: WeekDetection }; reading: ReadingReport; escalation?: EscalationOutcome }
  | { ok: false; status: number; body: Record<string, unknown> };

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const isPdfFile = (f: Pick<UploadFile, 'mimetype' | 'originalname'>) => f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname);
export const isImageFile = (f: Pick<UploadFile, 'mimetype' | 'originalname'>) => IMAGE_MIME_TYPES.includes(f.mimetype) || /\.(png|jpe?g|webp|gif)$/i.test(f.originalname);

const PROVIDER_CODE: Record<VisionProviderError['kind'], VisionErrorCode> = {
  busy: 'vision_busy',
  model_unavailable: 'vision_model_unavailable',
  failed: 'vision_failed',
  paused: 'vision_paused',
};

/** The week of a reading without day headers (a long-format template): the dates its rows carry. */
function weekOfRows(result: ParsedVisionResult, ctx: Pick<UploadReadContext, 'today' | 'clientWeekStart'>): WeekDetection {
  const dates = [...new Set(result.rows.map((r) => r.date))].sort();
  if (!dates.length) return detectWeek([], [], ctx).week;
  const counts = new Map<string, number>();
  for (const d of result.rows.map((r) => mondayOfIso(r.date))) counts.set(d, (counts.get(d) ?? 0) + 1);
  const weekStart = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  return { weekStart, weekEnd: addDays(weekStart, 6), source: 'printed_dates', printedLabel: `${dates[0]} … ${dates[dates.length - 1]}`, needsConfirmation: false, reason: null };
}

/** Fills the fields every outcome carries: people, unread rows, week. */
function complete(result: ParsedVisionResult, reader: 'ai' | 'table', ctx: UploadReadContext): ParsedVisionResult & { week: WeekDetection } {
  const people = result.people ?? peopleFromRows(result.rows, result.leaveRecords, reader);
  return {
    ...result,
    leaveRecords: result.leaveRecords.map(({ inferredDay: _inferred, ...l }) => l),
    rows: withPersonKeys(result.rows, people),
    people,
    unreadRows: result.unreadRows ?? [],
    week: result.week ?? weekOfRows(result, ctx),
  };
}

function report(
  result: ParsedVisionResult,
  parts: {
    ai: ReadingReport['ai'];
    table: ReadingReport['table'];
    tableResult: ParsedVisionResult | null;
    ai_?: AiReadOutcome | null;
    disagreements?: number;
    /** Cells the AI cross-check read differently where the file's own text was used (not flagged). */
    aiDiffCells?: number;
    fromCache?: boolean;
    crossChecked?: CrossChecked;
    cells?: CellsToCheck;
  },
): ReadingReport {
  const differed = parts.aiDiffCells ?? 0;
  const crossCheckNote = differed > 0 ? `The AI cross-check differed on ${differed} ${differed === 1 ? 'cell' : 'cells'}; the file's own text was used.` : null;
  const note = [hardToReadNote(parts.cells), readingNote(parts.ai, parts.table, parts.crossChecked ?? 'no'), crossCheckNote].filter(Boolean).join(' ') || null;
  return {
    ai: parts.ai,
    table: parts.table,
    rowsDetected: parts.tableResult ? (parts.tableResult.people?.length ?? 0) + (parts.tableResult.unreadRows?.length ?? 0) : null,
    peopleFound: result.people?.length ?? 0,
    rereadPages: parts.ai_?.rereadPages ?? [],
    disagreements: parts.disagreements ?? 0,
    ...(differed > 0 ? { aiDifferedCells: differed } : {}),
    fromCache: !!parts.fromCache,
    ...(note ? { note } : {}),
    ...(parts.crossChecked === 'yes' ? { crossChecked: true } : {}),
  };
}

/** Whether a photo or scan got its second, column-by-column AI reading. */
type CrossChecked = 'yes' | 'failed' | 'no';

/** Cells (person and day) the two readings of a photo or scan compared, and those they read differently. */
type CellsToCheck = { toCheck: number; compared: number; unreliablePages?: { page: number; toCheck: number; compared: number }[] };

/** Said first when many cells of a photo or scan were read two ways (none of them was imported). */
function hardToReadNote(cells: CellsToCheck | undefined): string | null {
  if (!cells || cells.toCheck === 0) return null;
  const untrusted = cells.unreliablePages ?? [];
  if (untrusted.length) {
    const which = untrusted.length === 1 && untrusted[0]!.page === 1 && cells.compared === untrusted[0]!.compared ? 'none of its shifts were' : `nothing from page ${untrusted.map((u) => u.page).join(', ')} was`;
    return `This photo was hard to read — the two readings disagreed on too much of it, so ${which} imported and ${cells.toCheck} ${cells.toCheck === 1 ? 'day needs' : 'days need'} checking; for best results upload the original PDF or spreadsheet.`;
  }
  const many = cells.toCheck >= 5 || cells.toCheck / Math.max(1, cells.compared) >= 0.1;
  if (!many) return null;
  return `This photo was hard to read — ${cells.toCheck} ${cells.toCheck === 1 ? 'cell needs' : 'cells need'} checking; for best results upload the original PDF or spreadsheet.`;
}

/** How the reading was checked, in plain words for the review screen. */
function readingNote(ai: ReadingReport['ai'], table: ReadingReport['table'], crossChecked: CrossChecked): string | null {
  const aiRead = ai === 'used' || ai === 'cached';
  if (aiRead && table === 'used') return 'Read by the AI reader and cross-checked, row by row, against the file\'s own text by the built-in reader.';
  if (aiRead && crossChecked === 'yes') return 'A photo or scan has no text for the built-in reader, so the AI reader read it twice — person by person and day by day — and the two readings were compared. Only what both saw was imported; a day they read differently is shown to check.';
  if (aiRead && crossChecked === 'failed') return 'A photo or scan has no text for the built-in reader, and the second AI reading could not be made: only the AI reader\'s own row counts were the check. Check every row.';
  if (aiRead) return 'Read by the AI reader; its own row counts and a second, page-by-page read were the check.';
  if (table === 'used') return 'Read by the built-in reader only.';
  return null;
}

/** Why the AI reader didn't run, as the report's `ai` value. */
type AiSkip = { ai: 'declined' | 'unavailable' | 'paused'; message: string; code: string; status: number };

export async function readUploadedRoster(file: UploadFile, ctx: UploadReadContext): Promise<UploadReadOutcome> {
  const gridParser = ctx.gridParser ?? parseExcelGrid;
  const week = { today: ctx.today, clientWeekStart: ctx.clientWeekStart };
  const sha = fileSha256(file.buffer);

  /**
   * One AI reading of this file: from the cache, or from the provider once the consent and
   * allowance gates pass. Returns the reading, or why there is none (never throws for a
   * provider failure).
   */
  type AiRead = { outcome: AiReadOutcome; result: ParsedVisionResult; fromCache: boolean; crossChecked: CrossChecked; disagreements: number; cells?: CellsToCheck };
  /** The second reading of a photo or scan compared with the first (aiCrossCheck.ts). */
  const withCrossCheck = (first: ParsedVisionResult, crossAnswer: ReadingAnswer | null | undefined, wanted: boolean): Pick<AiRead, 'result' | 'crossChecked' | 'disagreements' | 'cells'> => {
    if (!wanted) return { result: first, crossChecked: 'no', disagreements: 0 };
    if (!crossAnswer) return { result: first, crossChecked: 'failed', disagreements: 0 };
    const checked = crossCheckAiReadings(first, mapReadingAnswer(crossAnswer, week));
    return { result: checked.result, crossChecked: 'yes', disagreements: checked.disagreements, cells: { toCheck: checked.cellsToCheck, compared: checked.cellsCompared, unreliablePages: checked.unreliablePages } };
  };

  /**
   * One AI reading of this file: from the cache, or from the provider once the consent and
   * allowance gates pass. A photo or scan (`crossCheck`) is read twice at once — person by person
   * and day column by day column — and the two readings compared. Returns the reading, or why
   * there is none (never throws for a provider failure).
   */
  const readWithAi = async (
    source: AiReadSource,
    reason: EscalationReason,
    tablePeoplePerPage?: Map<number, number>,
    crossCheck = false,
  ): Promise<AiRead | AiSkip> => {
    const cached = ctx.cache ? await ctx.cache.get(ctx.locationId ?? 'local', sha).catch(() => null) : null;
    if (cached) {
      const { cross, ...answer } = cached;
      // A page the reading still came up short on stays reported as rows to check.
      const shortPages = shortPagesOf(answer, tablePeoplePerPage);
      const outcome: AiReadOutcome = { answer, calls: 0, rereadPages: [], missingPages: [], shortPages, complete: !shortPages.length, cacheable: true, model: 'cache', tokensIn: 0, tokensOut: 0 };
      console.log(`[roster-reading] AI reading reused from this venue's cache (${answer.pages.length} page(s)); no model call.`);
      return { outcome, fromCache: true, ...withCrossCheck(aiResult(outcome, week), cross, crossCheck) };
    }
    if (!ctx.provider) return { ai: 'unavailable', message: VISION_ERROR_MESSAGES.vision_unconfigured, code: 'vision_unconfigured', status: 422 };
    if (!ctx.aiConsent) return { ai: 'declined', message: `${ESCALATION_REASON_TEXT[reason]} ${AI_CONSENT_MESSAGE}`, code: 'ai_consent_required', status: 422 };
    const blocked = await ctx.aiBlockedReason();
    if (blocked) return { ai: 'unavailable', message: blocked, code: 'vision_fallback_blocked', status: 422 };
    const options = { provider: ctx.provider, locationId: ctx.locationId, userId: ctx.userId, deadline: ctx.deadline };
    // Both readings at once: the wall time is the slower of the two.
    const [primary, cross] = await Promise.allSettled([
      aiReadRoster(source, { ...options, ...(tablePeoplePerPage ? { tablePeoplePerPage } : {}) }),
      crossCheck && source.kind === 'file' ? aiCrossRead(source, options) : Promise.resolve(null),
    ]);
    if (cross.status === 'rejected') throw cross.reason;
    const crossAnswer = cross.value?.answer ?? null;
    if (primary.status === 'rejected') {
      const err = primary.reason;
      if (!(err instanceof VisionProviderError)) throw err;
      if (crossAnswer) {
        // The first reading failed but the second answered: it is the reading, unchecked.
        await ctx.markAiUsed();
        const outcome: AiReadOutcome = { answer: crossAnswer, calls: cross.value!.calls, rereadPages: [], missingPages: [], shortPages: [], complete: false, cacheable: false, model: ctx.provider.model, tokensIn: 0, tokensOut: 0 };
        return { outcome, result: aiResult(outcome, week), fromCache: false, crossChecked: 'failed', disagreements: 0 };
      }
      const code = PROVIDER_CODE[err.kind];
      return { ai: err.kind === 'paused' ? 'paused' : 'unavailable', message: visionErrorMessage(code, err.cause), code, status: 422 };
    }
    const outcome = primary.value;
    await ctx.markAiUsed();
    // A complete reading is cached (one still short after its re-read too: asking again gives the
    // same answer) — for a photo or scan, with its cross-check.
    if (outcome.cacheable && ctx.cache && (!crossCheck || crossAnswer)) {
      await ctx.cache.put(ctx.locationId ?? 'local', sha, crossAnswer ? { ...outcome.answer, cross: crossAnswer } : outcome.answer).catch(() => undefined);
    }
    return { outcome, fromCache: false, ...withCrossCheck(aiResult(outcome, week), crossAnswer, crossCheck) };
  };

  /** A 422 for an AI read that was the only way to read this file. */
  const refused = (skip: AiSkip, reason: EscalationReason): UploadReadOutcome => {
    if (skip.code === 'ai_consent_required') return { ok: false, status: 422, body: { error: skip.message, errorCode: 'ai_consent_required', escalationReason: reason } };
    return { ok: false, status: skip.status, body: { error: withManualPath(skip.message), errorCode: skip.code } };
  };

  /** The table reader's result alone, with a note on what the AI reader would have added. */
  const tableOnly = (table: ParsedVisionResult, skip: AiSkip | null, reason: EscalationReason | null, extra: { ai?: ReadingReport['ai']; tableState?: ReadingReport['table'] } = {}): UploadReadOutcome => {
    const result = complete(table, 'table', ctx);
    const escalation: EscalationOutcome | undefined =
      skip && reason && skip.code !== 'vision_unconfigured'
        ? { reason, status: skip.code === 'ai_consent_required' ? 'needs_consent' : 'unavailable', message: skip.message }
        : undefined;
    return { ok: true, result, reading: report(result, { ai: extra.ai ?? skip?.ai ?? 'not_used', table: extra.tableState ?? 'used', tableResult: table }), ...(escalation ? { escalation } : {}) };
  };

  // --- photos and screenshots -------------------------------------------------------------------
  if (isImageFile(file)) {
    const read = await readWithAi({ kind: 'file', data: file.buffer, mimeType: file.mimetype, name: file.originalname, pageCount: 1 }, 'image_or_scan', undefined, true);
    if ('ai' in read) return refused(read, 'image_or_scan');
    const result = complete(read.result, 'ai', ctx);
    return {
      ok: true,
      result,
      reading: report(result, { ai: read.fromCache ? 'cached' : 'used', table: 'not_applicable', tableResult: null, ai_: read.outcome, fromCache: read.fromCache, disagreements: read.disagreements, crossChecked: read.crossChecked, cells: read.cells }),
    };
  }

  // --- PDFs ---------------------------------------------------------------------------------------
  if (isPdfFile(file)) {
    const hasText = await hasPdfTextLayer(file.buffer);
    if (!hasText) {
      // A scan: the local Docling sidecar first (when one runs), then the AI reader.
      let docling: ParsedVisionResult | null = null;
      try {
        docling = await parseScannedPdfViaDocling(file.buffer, file.originalname, ctx.clientWeekStart ?? ctx.today);
      } catch (err) {
        if (!(err instanceof DoclingUnavailableError)) throw err;
      }
      // A sidecar result with nothing in it is no reading at all: go on to the AI reader.
      if (docling && !docling.rows.length && !(docling.people?.length ?? 0)) docling = null;
      const pageCount = await pdfPageCount(file.buffer);
      const read = await readWithAi({ kind: 'file', data: file.buffer, mimeType: 'application/pdf', name: file.originalname, pageCount }, 'image_or_scan', undefined, true);
      if ('ai' in read) return docling ? tableOnly(docling, read, 'image_or_scan') : refused(read, 'image_or_scan');
      const { result: merged, disagreements } = reconcileReadings(read.result, docling);
      const result = complete(merged, 'ai', ctx);
      return {
        ok: true,
        result,
        reading: report(result, {
          ai: read.fromCache ? 'cached' : 'used',
          table: docling ? 'used' : 'not_applicable',
          tableResult: docling,
          ai_: read.outcome,
          disagreements: disagreements + read.disagreements,
          fromCache: read.fromCache,
          crossChecked: read.crossChecked,
          cells: read.cells,
        }),
      };
    }

    // A text-layer PDF: the table reader reads it here, the AI reader reads it too.
    const table = await extractPdfTable(file.buffer);
    let tableResult: ParsedVisionResult | null = null;
    let tableState: ReadingReport['table'] = 'failed';
    let dataLoss: RosterExtractionAnomalyError | null = null;
    if (table.grid.length) {
      try {
        const grid = gridParser(table.grid, ctx.clientWeekStart ?? ctx.today, { ...week, rowRefs: table.rowRefs, inferredCells: table.inferredCells });
        if (grid.templateLabel === 'Deterministic Grid Parser') {
          tableResult = grid;
          tableState = 'used';
        }
      } catch (err) {
        if (!(err instanceof RosterExtractionAnomalyError)) throw err;
        dataLoss = err;
      }
    }
    if (!tableResult && !dataLoss) {
      // Not a day grid: the line-by-line text reader (cheap, no API call).
      const parser = new PDFParse({ data: file.buffer });
      let text = '';
      try {
        text = ((await parser.getText())?.text ?? '').trim();
      } finally {
        await parser.destroy();
      }
      const lines = text ? parseRosterText(text, ctx.clientWeekStart ?? ctx.today, week) : null;
      if (lines && lines.rows.length > 0) {
        tableResult = { templateLabel: 'PDF Text Roster', rows: lines.rows, issues: lines.issues, anomalies: [], leaveRecords: [], legend: [], week: lines.week };
        tableState = 'used';
      }
    }
    const reason: EscalationReason = dataLoss
      ? 'extraction_anomaly'
      : !tableResult
        ? 'unrecognized_layout'
        : (deterministicEscalationReason(tableResult) ?? ((tableResult.unreadRows?.length ?? 0) > 0 ? 'rows_not_read' : 'ai_cross_check'));
    const perPage = new Map<number, number>();
    for (const p of tableResult?.people ?? []) if (p.sourcePage) perPage.set(p.sourcePage, (perPage.get(p.sourcePage) ?? 0) + 1);
    const read = await readWithAi(
      { kind: 'file', data: file.buffer, mimeType: 'application/pdf', name: file.originalname, pageCount: table.pageCount, pageTexts: table.pageTexts },
      reason,
      perPage,
    );
    if ('ai' in read) {
      if (tableResult) return tableOnly(tableResult, read, reason, { tableState });
      if (dataLoss && read.code === 'vision_unconfigured') return { ok: false, status: 422, body: { error: withManualPath(dataLoss.message), errorCode: 'roster_extraction_anomaly' } };
      return refused(read, reason);
    }
    const { result: merged, disagreements, aiDiffCells } = reconcileReadings(read.result, tableResult);
    const result = complete(merged, 'ai', ctx);
    return { ok: true, result, reading: report(result, { ai: read.fromCache ? 'cached' : 'used', table: tableState, tableResult, ai_: read.outcome, disagreements, aiDiffCells, fromCache: read.fromCache }) };
  }

  // --- spreadsheets ---------------------------------------------------------------------------------
  try {
    const workbook = parseWorkbookBuffer(file.buffer, file.originalname);
    const result = complete({ templateLabel: workbook.templateLabel ?? 'template', rows: workbook.rows, issues: workbook.issues, anomalies: [], leaveRecords: [], legend: [] }, 'table', ctx);
    return { ok: true, result, reading: report(result, { ai: 'not_used', table: 'used', tableResult: result }) };
  } catch (err) {
    if (!(err instanceof TemplateDetectionError)) throw err;
  }
  // Not one of the long-format templates: a day grid (day columns, merged section headers).
  const grid = buildMergeExpandedGrid(file.buffer, file.originalname);
  // Every parser in this app only ever reads the workbook's first sheet — surfaced
  // unconditionally whenever more than one sheet exists, since only the manager can tell
  // whether the other tabs matter.
  const otherSheetNames = listOtherSheetNames(file.buffer, file.originalname);
  const ignoredSheetsAnomaly: AnomalyRecord | null =
    otherSheetNames.length > 0
      ? {
          employeeName: null,
          date: null,
          rawText: otherSheetNames.join(', '),
          reason:
            `This file has ${otherSheetNames.length} other sheet(s) that were not read (${otherSheetNames.join(', ')}) — ` +
            `only the first sheet was parsed, and no rows were extracted from the other sheet(s) listed above ` +
            `(this is a diagnostic, not an automatic recovery). If your roster data is on a different tab, move ` +
            `or copy it to the first tab and re-upload.`,
          confidence: 0,
          rowNumber: null,
          kind: 'ignored_workbook_sheets',
        }
      : null;
  const withSheetsNote = (r: ParsedVisionResult): ParsedVisionResult => (ignoredSheetsAnomaly ? { ...r, anomalies: [ignoredSheetsAnomaly, ...r.anomalies] } : r);
  const gridSource: AiReadSource = { kind: 'grid', text: gridToTsvText(grid), name: file.originalname };

  let gridResult: ParsedVisionResult | null = null;
  let dataLoss: RosterExtractionAnomalyError | null = null;
  try {
    gridResult = gridParser(grid, ctx.clientWeekStart ?? ctx.today, week);
  } catch (err) {
    if (!(err instanceof RosterExtractionAnomalyError)) throw err;
    dataLoss = err;
  }
  if (dataLoss) {
    // The grid parser proved it dropped real data: the AI reader (with consent), else a clear 422.
    const read = await readWithAi(gridSource, 'extraction_anomaly');
    if ('ai' in read) {
      if (read.code === 'vision_unconfigured') return { ok: false, status: 422, body: { error: withManualPath(dataLoss.message), errorCode: 'roster_extraction_anomaly' } };
      return refused(read, 'extraction_anomaly');
    }
    const result = complete(withSheetsNote(read.result), 'ai', ctx);
    return {
      ok: true,
      result,
      reading: report(result, { ai: read.fromCache ? 'cached' : 'used', table: 'failed', tableResult: null, ai_: read.outcome, fromCache: read.fromCache }),
      escalation: { reason: 'extraction_anomaly', status: 'used', message: 'Read by the AI reader. Check every row before confirming.' },
    };
  }
  if (gridResult!.templateLabel !== 'Deterministic Grid Parser') {
    // A layout the grid parser genuinely doesn't recognise (e.g. days-as-rows).
    const read = await readWithAi(gridSource, 'unrecognized_layout');
    if ('ai' in read) {
      if (read.code === 'vision_unconfigured') {
        const local = processRowsIntoRoster(grid, ctx.clientWeekStart ?? undefined);
        const result = complete(withSheetsNote({ ...local, templateLabel: 'Deterministic local parser (AI roster reading not configured)' }), 'table', ctx);
        return { ok: true, result, reading: report(result, { ai: 'unavailable', table: 'used', tableResult: result }) };
      }
      return refused(read, 'unrecognized_layout');
    }
    const result = complete(withSheetsNote(read.result), 'ai', ctx);
    return { ok: true, result, reading: report(result, { ai: read.fromCache ? 'cached' : 'used', table: 'failed', tableResult: null, ai_: read.outcome, fromCache: read.fromCache }) };
  }

  // Recognised. The AI reader only when the result can't be trusted as it is.
  const local = gridResult!;
  const coverageGap = (local.unreadRows?.length ?? 0) > 0 || (local.people?.length ?? 0) === 0;
  const reason: EscalationReason | null = deterministicEscalationReason(local) ?? (coverageGap ? 'rows_not_read' : null);
  if (!reason) return tableOnly(withSheetsNote(local), null, null);
  if (!ctx.provider) return tableOnly(withSheetsNote(local), null, null, { ai: 'unavailable' });
  const read = await readWithAi(gridSource, reason);
  if ('ai' in read) {
    const outcome = tableOnly(withSheetsNote(local), read, reason);
    if (outcome.ok && outcome.escalation?.status === 'unavailable') outcome.escalation.message = `${read.message} The built-in reader's result is shown instead.`;
    return outcome;
  }
  const { result: merged, disagreements, aiDiffCells } = reconcileReadings(read.result, local);
  const result = complete(withSheetsNote(merged), 'ai', ctx);
  return {
    ok: true,
    result,
    reading: report(result, { ai: read.fromCache ? 'cached' : 'used', table: 'used', tableResult: local, ai_: read.outcome, disagreements, aiDiffCells, fromCache: read.fromCache }),
    escalation: { reason, status: 'used', message: 'Read by the AI reader. Check every row before confirming.' },
  };
}
