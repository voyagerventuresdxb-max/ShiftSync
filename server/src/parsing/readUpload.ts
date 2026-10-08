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
import { aiCrossRead, crossCheckAiReadings, withheldPageReason } from './aiCrossCheck.js';
import type { ReadingAnswer } from './vlmPrompt.js';
import { emitReadProgress, type OnReadProgress, type ReadProgressEvent } from './readProgress.js';
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
  /** Told which step the read is on (readProgress.ts): stages and page numbers only. */
  onProgress?: OnReadProgress;
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

/** What the review says about a shift whose day was inferred and that nothing confirmed. */
const INFERRED_DAY =
  "This shift's day could only be inferred from how the file's columns line up, and nothing confirmed it, so it was not imported. Check the day on the roster and add the shift on the rota.";

/**
 * Fills the fields every outcome carries: people, unread rows, week. A shift whose day the
 * table reader inferred and no second reading confirmed is never saved: it is shown, with the
 * day it would have had, as a day to check.
 */
function complete(result: ParsedVisionResult, reader: 'ai' | 'table', ctx: UploadReadContext): ParsedVisionResult & { week: WeekDetection } {
  const people = result.people ?? peopleFromRows(result.rows, result.leaveRecords, reader);
  const guessed = result.rows.filter((r) => r.inferredDay);
  const unconfirmed = guessed.map((r) => ({ employeeName: r.employeeName, date: r.date, rawText: `${r.startTime}–${r.endTime}`, reason: INFERRED_DAY, confidence: 0.3, rowNumber: null }));
  return {
    ...result,
    anomalies: [...result.anomalies, ...unconfirmed],
    leaveRecords: result.leaveRecords.map(({ inferredDay: _inferred, ...l }) => l),
    rows: withPersonKeys(guessed.length ? result.rows.filter((r) => !r.inferredDay) : result.rows, people),
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
  const what = parts.table === 'not_applicable' ? 'photo' : 'file';
  const note = [hardToReadNote(parts.cells, what), readingNote(parts.ai, parts.table, parts.crossChecked ?? 'no'), crossCheckNote].filter(Boolean).join(' ') || null;
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
    ...(parts.cells?.withheld.length ? { withheldPages: parts.cells.withheld.map(({ page, reason }) => ({ page, reason })) } : {}),
  };
}

/** Whether a photo or scan got its second, column-by-column AI reading. */
type CrossChecked = 'yes' | 'failed' | 'no';

/**
 * Cells (person and day) the two readings of a photo or scan compared, those they read
 * differently, and the pages nothing was imported from (with why, for the review screen).
 */
type CellsToCheck = {
  toCheck: number;
  compared: number;
  withheld: { page: number; reason: string }[];
  pageCount: number;
  secondFailed?: boolean;
  /** A text PDF whose day columns couldn't be anchored: pages the two AI readings disagreed on too much (only days the file's text and an AI reading agree on were kept). */
  doubtedPages?: number[];
};

/**
 * Said first when a file read twice by the AI reader (a photo or scan; a text PDF or a
 * spreadsheet the built-in reader couldn't anchor) was hard to read: pages nothing was imported
 * from, or many cells read two ways.
 */
function hardToReadNote(cells: CellsToCheck | undefined, what: 'photo' | 'file'): string | null {
  if (!cells) return null;
  if (cells.secondFailed) {
    const of = what === 'photo' ? 'this photo or scan' : 'this file';
    return `The second AI reading of ${of} could not be made, so it could not be checked and nothing was imported — no people, no shifts. Upload it again in a minute, or upload the original PDF or spreadsheet.`;
  }
  if (cells.doubtedPages?.length) {
    return `This file's day columns don't line up with its header, and the two AI readings disagreed on, or were unsure of, too much of page ${cells.doubtedPages.join(', ')}, so from it only the days the file's own text and an AI reading agree on were imported; every other day is shown to check. For best results upload the original spreadsheet.`;
  }
  if (cells.withheld.length) {
    const all = cells.withheld.length >= cells.pageCount;
    const which = all ? 'nothing from it' : `nothing from page ${cells.withheld.map((u) => u.page).join(', ')}`;
    return `This ${what} was hard to read — the two readings disagreed on, or were unsure of, too much of it, so ${which} was imported: no people, no shifts. For best results upload the original PDF or spreadsheet, or add the people by hand.`;
  }
  if (cells.toCheck === 0) return null;
  const many = cells.toCheck >= 5 || cells.toCheck / Math.max(1, cells.compared) >= 0.1;
  if (!many) return null;
  return `This ${what} was hard to read — ${cells.toCheck} ${cells.toCheck === 1 ? 'cell needs' : 'cells need'} checking; for best results upload the original PDF or spreadsheet.`;
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
  const progress = (event: ReadProgressEvent) => emitReadProgress(ctx.onProgress, event);

  /**
   * One AI reading of this file: from the cache, or from the provider once the consent and
   * allowance gates pass. Returns the reading, or why there is none (never throws for a
   * provider failure).
   */
  type AiRead = {
    outcome: AiReadOutcome;
    result: ParsedVisionResult;
    fromCache: boolean;
    crossChecked: CrossChecked;
    disagreements: number;
    cells?: CellsToCheck;
    /** The two AI readings on their own (read twice), each able to confirm a day the table reader inferred. */
    readings?: ParsedVisionResult[];
  };
  /**
   * The second reading of a photo or scan compared with the first (aiCrossCheck.ts). With no
   * second reading nothing can be checked, so nothing is imported: a photo may fail loudly, it
   * never saves an unchecked reading.
   */
  const withCrossCheck = (first: ParsedVisionResult, crossAnswer: ReadingAnswer | null | undefined, wanted: boolean, pageCount: number): Pick<AiRead, 'result' | 'crossChecked' | 'disagreements' | 'cells' | 'readings'> => {
    if (!wanted) return { result: first, crossChecked: 'no', disagreements: 0 };
    if (!crossAnswer) {
      const reason = 'The second AI reading of this page could not be made, so it could not be checked and nothing from it was imported. Upload it again in a minute, or upload the original PDF or spreadsheet.';
      const withheld = Array.from({ length: Math.max(1, pageCount) }, (_, i) => ({ page: i + 1, reason }));
      const nothing: ParsedVisionResult = { ...first, rows: [], leaveRecords: [], anomalies: [], people: [], unreadRows: withheld.map((w) => ({ page: w.page, row: null, text: '', reason: w.reason })) };
      return { result: nothing, crossChecked: 'failed', disagreements: 0, cells: { toCheck: 0, compared: 0, withheld, pageCount, secondFailed: true } };
    }
    progress({ kind: 'cross_check' });
    const second = mapReadingAnswer(crossAnswer, week);
    const checked = crossCheckAiReadings(first, second);
    const withheld = checked.withheldPages.map((u) => ({ page: u.page, reason: withheldPageReason(u) }));
    return { result: checked.result, crossChecked: 'yes', disagreements: checked.disagreements, cells: { toCheck: checked.cellsToCheck, compared: checked.cellsCompared, withheld, pageCount }, readings: [first, second] };
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
    const stored = ctx.cache ? await ctx.cache.get(ctx.locationId ?? 'local', sha).catch(() => null) : null;
    // A reading kept without its second reading can't stand in for one that needs it.
    const cached = stored && (!crossCheck || stored.cross) ? stored : null;
    if (cached) {
      const { cross, ...answer } = cached;
      // A page the reading still came up short on stays reported as rows to check.
      const shortPages = shortPagesOf(answer, tablePeoplePerPage);
      const outcome: AiReadOutcome = { answer, calls: 0, rereadPages: [], missingPages: [], shortPages, complete: !shortPages.length, cacheable: true, model: 'cache', tokensIn: 0, tokensOut: 0 };
      console.log(`[roster-reading] AI reading reused from this venue's cache (${answer.pages.length} page(s)); no model call.`);
      return { outcome, fromCache: true, ...withCrossCheck(aiResult(outcome, week), cross, crossCheck, source.kind === 'file' ? source.pageCount : 1) };
    }
    if (!ctx.provider) return { ai: 'unavailable', message: VISION_ERROR_MESSAGES.vision_unconfigured, code: 'vision_unconfigured', status: 422 };
    if (!ctx.aiConsent) return { ai: 'declined', message: `${ESCALATION_REASON_TEXT[reason]} ${AI_CONSENT_MESSAGE}`, code: 'ai_consent_required', status: 422 };
    const blocked = await ctx.aiBlockedReason();
    if (blocked) return { ai: 'unavailable', message: blocked, code: 'vision_fallback_blocked', status: 422 };
    const options = { provider: ctx.provider, locationId: ctx.locationId, userId: ctx.userId, deadline: ctx.deadline };
    const secondRead = async (scan: AiReadSource) => {
      progress({ kind: 'second_read', state: 'started' });
      try {
        return await aiCrossRead(scan, options);
      } finally {
        progress({ kind: 'second_read', state: 'finished' });
      }
    };
    // Both readings at once: the wall time is the slower of the two.
    const [primary, cross] = await Promise.allSettled([
      aiReadRoster(source, { ...options, ...(tablePeoplePerPage ? { tablePeoplePerPage } : {}), onProgress: ctx.onProgress }),
      crossCheck ? secondRead(source) : Promise.resolve(null),
    ]);
    if (cross.status === 'rejected') throw cross.reason;
    const crossAnswer = cross.value?.answer ?? null;
    if (primary.status === 'rejected') {
      const err = primary.reason;
      if (!(err instanceof VisionProviderError)) throw err;
      if (crossAnswer) {
        // The first reading failed but the second answered: nothing to check it against, so nothing is imported.
        await ctx.markAiUsed();
        const outcome: AiReadOutcome = { answer: crossAnswer, calls: cross.value!.calls, rereadPages: [], missingPages: [], shortPages: [], complete: false, cacheable: false, model: ctx.provider.model, tokensIn: 0, tokensOut: 0 };
        return { outcome, fromCache: false, ...withCrossCheck(aiResult(outcome, week), null, true, source.kind === 'file' ? source.pageCount : 1) };
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
    return { outcome, fromCache: false, ...withCrossCheck(aiResult(outcome, week), crossAnswer, crossCheck, source.kind === 'file' ? source.pageCount : 1) };
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
      // A page the AI readings don't vouch for saves nothing; the sidecar's reading (no pages of its own) can't fill it in.
      if (read.cells?.withheld.length) docling = null;
      if (docling) progress({ kind: 'cross_check' });
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
    progress({ kind: 'text' });
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
    // Day columns the table reader couldn't anchor on the header (or no table reading at all):
    // nothing the AI reads is confirmed by the file's text, so it is read twice like a photo and
    // only what both readings agree on can be saved.
    const anchored = !!tableResult && !dataLoss && (tableResult.rows.length > 0 || (tableResult.people?.length ?? 0) > 0) && table.unanchoredPages.length === 0;
    const read = await readWithAi(
      { kind: 'file', data: file.buffer, mimeType: 'application/pdf', name: file.originalname, pageCount: table.pageCount, pageTexts: table.pageTexts },
      reason,
      perPage,
      !anchored,
    );
    // A page whose day columns couldn't be lined up with its header: no shift from it is saved,
    // however many readings agree (they can agree on the same day off); everyone is listed and
    // every day shown to check.
    const unlined = table.unanchoredPages;
    const unlinedNote = unlined.length
      ? `The day columns on page${unlined.length === 1 ? '' : 's'} ${unlined.join(', ')} couldn't be lined up with the day headings, so no shift from ${unlined.length === 1 ? 'it' : 'them'} was imported: everyone on ${unlined.length === 1 ? 'it' : 'them'} is listed and every day is shown to check. Upload the original file or a corrected export to import the shifts.`
      : null;
    const withUnlinedNote = (o: UploadReadOutcome): UploadReadOutcome => (unlinedNote && o.ok ? { ...o, reading: { ...o.reading, note: [unlinedNote, o.reading.note].filter(Boolean).join(' ') } } : o);
    if ('ai' in read) {
      if (tableResult) return withUnlinedNote(tableOnly(tableResult, read, reason, { tableState }));
      if (dataLoss && read.code === 'vision_unconfigured') return { ok: false, status: 422, body: { error: withManualPath(dataLoss.message), errorCode: 'roster_extraction_anomaly' } };
      return refused(read, reason);
    }
    if (tableResult) progress({ kind: 'cross_check' });
    // A page the two AI readings disagreed on too much still has the file's own text: its days the
    // text and an AI reading agree on are kept, every other one is shown — said in the note, not as
    // a page with nothing on it.
    let aiReading = read.result;
    let cells = read.cells;
    if (tableResult && cells?.withheld.length) {
      const doubted = new Set(cells.withheld.map((w) => w.page));
      aiReading = { ...aiReading, unreadRows: (aiReading.unreadRows ?? []).filter((u) => !(u.row === null && !u.text && doubted.has(u.page ?? 1))) };
      cells = { ...cells, withheld: [], doubtedPages: [...doubted] };
    }
    const { result: merged, disagreements, aiDiffCells } = reconcileReadings(aiReading, tableResult, { aiConfirmed: read.crossChecked === 'yes', ...(read.readings ? { confirmWith: read.readings } : {}) });
    if (cells?.doubtedPages?.length && read.readings) {
      // On a page the AI readings disagreed on too much, a person only an AI reading listed is
      // never imported — but stays visible, as a row to check.
      const key = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      const known = new Set((merged.people ?? []).map((p) => key(p.name)));
      const doubted = new Set(cells.doubtedPages);
      const unread = [...(merged.unreadRows ?? [])];
      for (const reading of read.readings) {
        for (const p of reading.people ?? []) {
          if (!doubted.has(p.sourcePage ?? 1) || known.has(key(p.name))) continue;
          known.add(key(p.name));
          const days = reading.rows.filter((r) => key(r.employeeName) === key(p.name)).map((r) => `${r.date.slice(5)} ${r.startTime}–${r.endTime}`);
          unread.push({ page: p.sourcePage, row: p.sourceRow, text: [p.name, ...days].join(' | '), reason: "Only an AI reading listed this row, and the file's own text and the other reading don't show it, so it was not imported. Add them by hand if they're on the roster." });
        }
      }
      merged.unreadRows = unread;
    }
    if (unlined.length) {
      const off = new Set(unlined);
      merged.rows = merged.rows.map((r) => (r.sourcePage == null || off.has(r.sourcePage) ? { ...r, inferredDay: true } : r));
    }
    const result = complete(merged, 'ai', ctx);
    return withUnlinedNote({
      ok: true,
      result,
      reading: report(result, {
        ai: read.fromCache ? 'cached' : 'used',
        table: tableState,
        tableResult,
        ai_: read.outcome,
        disagreements: disagreements + read.disagreements,
        aiDiffCells,
        fromCache: read.fromCache,
        crossChecked: read.crossChecked,
        cells,
      }),
    });
  }

  // --- spreadsheets ---------------------------------------------------------------------------------
  progress({ kind: 'text' });
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
    // No table reading to confirm the AI's: it reads the grid twice and only what both agree on is saved.
    const read = await readWithAi(gridSource, 'extraction_anomaly', undefined, true);
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
    const read = await readWithAi(gridSource, 'unrecognized_layout', undefined, true);
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
  progress({ kind: 'cross_check' });
  const { result: merged, disagreements, aiDiffCells } = reconcileReadings(read.result, local);
  const result = complete(withSheetsNote(merged), 'ai', ctx);
  return {
    ok: true,
    result,
    reading: report(result, { ai: read.fromCache ? 'cached' : 'used', table: 'used', tableResult: local, ai_: read.outcome, disagreements, aiDiffCells, fromCache: read.fromCache }),
    escalation: { reason, status: 'used', message: 'Read by the AI reader. Check every row before confirming.' },
  };
}
