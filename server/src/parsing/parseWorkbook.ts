import { readWorkbook, WorkbookReadError } from './workbookReader.js';
import { detectTemplate, describeExpectedTemplates } from './templates.js';
import { parseDateCell, parseTimeCell, parseTimeRangeCell, parseBreakMinutes, isOvernight } from './normalize.js';
import type { ParsedShiftRow, ParsedWorkbookResult, RowIssue, TemplateField } from './types.js';

export class TemplateDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateDetectionError';
  }
}

const MAX_ROWS = 5000;

/**
 * Reads a workbook buffer's first sheet into a 2D grid, with merged ranges
 * resolved (horizontal merges expanded, vertical ones left blank — see
 * workbookReader.ts) and columns aligned to the sheet's own used range, so
 * offsets don't shift when the data doesn't start at A1. Shared by the
 * long-format template parser below and by the grid-format (VLM/deterministic)
 * fallback path for sheets that don't match any of the 3 master templates.
 *
 * Async since the move off SheetJS (exceljs loads asynchronously).
 */
export async function buildMergeExpandedGrid(buffer: Buffer, originalFilename: string): Promise<unknown[][]> {
  const snapshot = await readWorkbookOrThrow(buffer, originalFilename);
  if (snapshot.sheetNames.length === 0) {
    throw new TemplateDetectionError(`"${originalFilename}" has no worksheets.`);
  }
  // Callers get their own rows: the snapshot is memoised per upload, so a
  // caller that mutated a shared row would corrupt the next caller's grid.
  return snapshot.grid.map((row) => row.slice());
}

async function readWorkbookOrThrow(buffer: Buffer, originalFilename: string) {
  try {
    return await readWorkbook(buffer);
  } catch (err) {
    if (err instanceof WorkbookReadError) {
      throw new TemplateDetectionError(`Could not read "${originalFilename}" as an Excel or CSV file: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Every OTHER sheet/tab name in the workbook besides the one actually read
 * (always `SheetNames[0]`, both here and in `parseWorkbookBuffer` below) —
 * empty for a normal single-sheet file. This app's parsers never read past
 * the first sheet at all (see the round-2 audit); this exists purely so a
 * caller can flag "this file has N other sheet(s) that were never looked
 * at" rather than silently importing whatever the first tab happens to
 * contain — a multi-outlet/multi-week workbook (notes-tab-first, an
 * archive tab, a per-outlet tab) is a realistic real-world shape for this
 * app's own target venues, and the wrong tab landing first can otherwise
 * look exactly like a normal successful import.
 */
export async function listOtherSheetNames(buffer: Buffer, originalFilename: string): Promise<string[]> {
  const snapshot = await readWorkbookOrThrow(buffer, originalFilename);
  return snapshot.sheetNames.slice(1);
}

/** Serializes a 2D grid into a tab-separated text block for the VLM text-ingestion path. */
export function gridToTsvText(grid: unknown[][]): string {
  return grid
    .map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))).join('\t'))
    .join('\n');
}

/**
 * Parses an uploaded .xlsx/.csv buffer into clean shift rows.
 * Throws TemplateDetectionError when the sheet matches none of the 3 master
 * templates (missing/renamed required columns) — callers should surface this
 * as a 422 with the expected-template description.
 */
export async function parseWorkbookBuffer(buffer: Buffer, originalFilename: string): Promise<ParsedWorkbookResult> {
  const grid: unknown[][] = await buildMergeExpandedGrid(buffer, originalFilename);

  if (grid.length === 0) {
    throw new TemplateDetectionError(`"${originalFilename}" is empty.`);
  }
  if (grid.length - 1 > MAX_ROWS) {
    throw new TemplateDetectionError(`"${originalFilename}" has more than ${MAX_ROWS} data rows — please split the file.`);
  }

  const [headerRow, ...dataRows] = grid;
  const match = detectTemplate(headerRow);
  if (!match) {
    throw new TemplateDetectionError(
      `Could not match "${originalFilename}" against any of ShiftSync's 3 master roster templates. ${describeExpectedTemplates()}`,
    );
  }

  const { template, columnMap } = match;
  const headerIndex = new Map<string, number>();
  headerRow.forEach((h, idx) => headerIndex.set(String(h ?? ''), idx));

  const columnIndexByField = new Map<TemplateField, number>(
    columnMap.map((c) => [c.field, headerIndex.get(c.columnHeader)!]),
  );

  const rows: ParsedShiftRow[] = [];
  const issues: RowIssue[] = [];

  dataRows.forEach((raw, i) => {
    const rowNumber = i + 2; // spreadsheet row (1 = header)
    const isBlank = raw.every((cell) => cell === null || cell === undefined || String(cell).trim() === '');
    if (isBlank) return;

    const get = (field: TemplateField) => {
      const idx = columnIndexByField.get(field);
      return idx === undefined ? null : raw[idx] ?? null;
    };

    const employeeNameRaw = get('employeeName');
    const roleRaw = get('role');
    const dateRaw = get('date');
    const managerNotesRaw = get('managerNotes');
    const breakRaw = get('breakMinutes');

    const employeeName = String(employeeNameRaw ?? '').trim();
    const roleName = String(roleRaw ?? '').trim();
    const isoDate = parseDateCell(dateRaw);
    const managerNotes = managerNotesRaw ? String(managerNotesRaw).trim() || null : null;
    const breakMinutes = parseBreakMinutes(breakRaw);

    const rowIssues: RowIssue[] = [];
    if (!employeeName) rowIssues.push({ rowNumber, field: 'employeeName', severity: 'error', message: 'Employee name is missing.' });
    if (!roleName) rowIssues.push({ rowNumber, field: 'role', severity: 'error', message: 'Role is missing.' });
    if (!isoDate) rowIssues.push({ rowNumber, field: 'date', severity: 'error', message: `Could not parse date value "${String(dateRaw)}".` });

    let startTime: string | null = null;
    let endTime: string | null = null;

    if (template.combinedTimeRange) {
      const range = parseTimeRangeCell(get('startTime'));
      if (range) {
        startTime = range.start;
        endTime = range.end;
      } else {
        rowIssues.push({ rowNumber, field: 'startTime', severity: 'error', message: `Could not parse shift time range "${String(get('startTime'))}".` });
      }
    } else {
      startTime = parseTimeCell(get('startTime'));
      endTime = parseTimeCell(get('endTime'));
      if (!startTime) rowIssues.push({ rowNumber, field: 'startTime', severity: 'error', message: `Could not parse start time "${String(get('startTime'))}".` });
      if (!endTime) rowIssues.push({ rowNumber, field: 'endTime', severity: 'error', message: `Could not parse end time "${String(get('endTime'))}".` });
    }

    if (startTime && endTime && startTime === endTime) {
      rowIssues.push({ rowNumber, field: 'endTime', severity: 'error', message: 'Start time and end time are identical (zero-length shift).' });
    }

    issues.push(...rowIssues);

    const hasBlockingError = rowIssues.some((i2) => i2.severity === 'error');
    if (hasBlockingError || !isoDate || !startTime || !endTime) return;

    rows.push({
      rowNumber,
      employeeName,
      roleName,
      date: isoDate,
      startTime,
      endTime,
      overnight: isOvernight(startTime, endTime),
      breakMinutes,
      managerNotes,
    });
  });

  return { templateId: template.id, templateLabel: template.label, rows, issues };
}
