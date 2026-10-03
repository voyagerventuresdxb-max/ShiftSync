import * as XLSXNS from 'xlsx';
import { detectTemplate, describeExpectedTemplates } from './templates.js';
import { parseDateCell, parseTimeCell, parseTimeRangeCell, parseBreakMinutes, isOvernight, excelSerialToUtcDate, cellToText } from './normalize.js';

// The CommonJS build exposes `SSF` only on the default export under Node's
// ESM interop (the namespace import carries `read`/`utils` but not `SSF`).
const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
import type { ParsedShiftRow, ParsedWorkbookResult, RowIssue, TemplateField } from './types.js';

export class TemplateDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateDetectionError';
  }
}

const MAX_ROWS = 5000;

/**
 * The one way this app reads a spreadsheet, chosen so the result is byte-for-
 * byte the same whatever the host's timezone:
 *
 *  - `cellDates: false`: SheetJS hands typed date/time cells back as their
 *    Excel SERIALS (the pure numbers in the file) instead of building JS Dates
 *    through the host's local clock, which shifted every typed time by the
 *    host offset (17:00 read as 13:18 on an Asia/Dubai host, 01:00 the next
 *    day in Los Angeles).
 *  - `cellNF: true`: keeps each cell's number format so `materializeDateCells`
 *    can tell a date/time serial from a plain number and turn it into a UTC
 *    Date itself (`excelSerialToUtcDate`, pure arithmetic).
 *  - `raw: true`: text formats (CSV, and HTML saved as .xls) are left as the
 *    text they are; `normalize.ts` parses them with its own locale-free
 *    formats. SheetJS's guesser used to turn `20-Aug-2026` into a host-local
 *    Date and `10-18` (a shift range) into the date 2001-10-18.
 */
export function readWorkbook(data: Buffer | ArrayBuffer | string, type: 'buffer' | 'array' | 'string' = 'buffer'): XLSXNS.WorkBook {
  const workbook = XLSX.read(data, { type, cellDates: false, cellNF: true, raw: true });
  for (const name of workbook.SheetNames) materializeDateCells(workbook.Sheets[name]!);
  return workbook;
}

/** Turns every date/time-formatted numeric cell into a UTC Date (see `readWorkbook`). Mutates in place. */
export function materializeDateCells(sheet: XLSXNS.WorkSheet): void {
  for (const addr of Object.keys(sheet)) {
    if (addr.startsWith('!')) continue;
    const cell = sheet[addr] as XLSXNS.CellObject | undefined;
    if (!cell || cell.t !== 'n' || typeof cell.v !== 'number' || !Number.isFinite(cell.v)) continue;
    if (!cell.z || !XLSX.SSF.is_date(String(cell.z))) continue;
    cell.v = excelSerialToUtcDate(cell.v);
    cell.t = 'd';
  }
}

/**
 * Expands every HORIZONTAL merged range in a worksheet (spanning multiple
 * COLUMNS within one row) by copying the top-left cell's value into every
 * cell it covers, mutating the sheet in place. Must run before
 * sheet_to_json, which otherwise leaves every covered cell but the top-left
 * blank — undercounting or misaligning rows whenever a source file merges a
 * day-header cell across several columns, or a role-section banner across
 * the full staff-block width.
 *
 * Deliberately does NOT expand a VERTICAL merge (spanning multiple ROWS in
 * one column, `range.e.r > range.s.r`) — every genuine merge shape this app
 * has ever seen in a real reference fixture is horizontal; a vertical merge
 * has no legitimate case here (see the round-2 audit) and is a real,
 * observed authoring pattern instead: a manager vertically merges a
 * staff-name cell across several rows purely for visual grouping, each row
 * still carrying that OWN row's real, DIFFERENT shift data underneath.
 * Auto-expanding it the same way a horizontal merge is expanded would
 * silently attribute every one of those rows' shifts to whoever's name
 * happens to be the merge's top-left cell — the other real employees those
 * rows may represent would vanish with zero anomaly, zero warning. Leaving
 * it un-expanded instead means those rows keep their real (blank) name
 * cell, which deterministicGridParser.ts's 'unrecognized_merged_name_cell'
 * handling then surfaces explicitly instead of silently dropping.
 */
function expandMergedCells(sheet: XLSXNS.WorkSheet): void {
  const merges = sheet['!merges'] ?? [];
  for (const range of merges) {
    if (range.e.r > range.s.r) continue; // vertical merge — never auto-expanded, see above
    const topLeftAddr = XLSX.utils.encode_cell({ r: range.s.r, c: range.s.c });
    const topLeftCell = sheet[topLeftAddr];
    if (!topLeftCell) continue;
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        if (r === range.s.r && c === range.s.c) continue;
        sheet[XLSX.utils.encode_cell({ r, c })] = { ...topLeftCell };
      }
    }
  }
}

/**
 * Reads a workbook buffer's first sheet into a 2D grid, with merged ranges
 * expanded and the range read explicitly from the sheet's own `!ref` (not a
 * trimmed/inferred range) so offsets don't shift when the data doesn't start
 * at A1. Shared by the long-format template parser below and by the
 * grid-format (VLM/deterministic) fallback path for sheets that don't match
 * any of the 3 master templates.
 */
export function buildMergeExpandedGrid(buffer: Buffer, originalFilename: string): unknown[][] {
  let workbook: XLSXNS.WorkBook;
  try {
    workbook = readWorkbook(buffer, 'buffer');
  } catch (err) {
    throw new TemplateDetectionError(
      `Could not read "${originalFilename}" as an Excel or CSV file: ${(err as Error).message}`,
    );
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new TemplateDetectionError(`"${originalFilename}" has no worksheets.`);
  }
  const sheet = workbook.Sheets[sheetName];
  expandMergedCells(sheet);
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    range: sheet['!ref'],
    blankrows: false,
    defval: null,
  });
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
export function listOtherSheetNames(buffer: Buffer, originalFilename: string): string[] {
  let workbook: XLSXNS.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', bookSheets: true });
  } catch (err) {
    throw new TemplateDetectionError(
      `Could not read "${originalFilename}" as an Excel or CSV file: ${(err as Error).message}`,
    );
  }
  return workbook.SheetNames.slice(1);
}

/** Serializes a 2D grid into a tab-separated text block for the VLM text-ingestion path. */
export function gridToTsvText(grid: unknown[][]): string {
  return grid.map((row) => row.map(cellToText).join('\t')).join('\n');
}

/**
 * Parses an uploaded .xlsx/.xls/.csv buffer into clean shift rows.
 * Throws TemplateDetectionError when the sheet matches none of the 3 master
 * templates (missing/renamed required columns) — callers should surface this
 * as a 422 with the expected-template description.
 */
export function parseWorkbookBuffer(buffer: Buffer, originalFilename: string): ParsedWorkbookResult {
  const grid: unknown[][] = buildMergeExpandedGrid(buffer, originalFilename);

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
