/**
 * Workbook reading for the roster-upload path, on exceljs.
 *
 * Replaces SheetJS `xlsx`, which has two unpatched high-severity advisories
 * with no fix on the npm registry (Issue #23: GHSA-4r6h-8v6p-xvw6 prototype
 * pollution, GHSA-5pgg-2g8v-p4x9 ReDoS) and parses every uploaded roster —
 * untrusted input by definition.
 *
 * exceljs is NOT a drop-in for SheetJS, so every difference that could change
 * what the parsers downstream see is handled — and tested — here, in one
 * place; nothing outside this file touches an exceljs type:
 *
 *  - Async. `load()` returns a Promise, so everything above this is async too.
 *  - Merged cells. exceljs makes EVERY cell inside a merge report the master's
 *    value (`MergeValue.value` -> `master.value`), vertical merges included.
 *    The old `expandMergedCells` deliberately expanded HORIZONTAL merges only
 *    (see the comment on `multiRowMergeSlaves`), so vertical/2-D slaves are
 *    explicitly blanked here — otherwise a vertically merged staff-name cell
 *    would silently re-attribute every row's shifts to its top-left name.
 *  - Cell values. exceljs returns objects for formulas, rich text, hyperlinks
 *    and errors where `sheet_to_json` returned the cached scalar. See
 *    `normalizeCellValue`.
 *  - Formats. exceljs cannot read legacy binary `.xls` (OLE2/BIFF), nor the
 *    HTML/XML "spreadsheets" some systems export under an `.xls` name, which
 *    SheetJS did. Those are rejected with an actionable message instead of
 *    being fed to the CSV parser as garbage. Format is sniffed from the file's
 *    bytes, never its name or mimetype: browsers on Windows label plain CSVs
 *    `application/vnd.ms-excel`.
 *  - CSV. exceljs's default CSV reader is comma-only and, by default, turns
 *    whitespace-only cells into `0` and date-looking strings into LOCAL-time
 *    `Date`s (which the parsers, reading UTC, would see a day early in any
 *    UTC+ zone such as Asia/Dubai). So CSV is read with its own delimiter
 *    detection and value mapping — see `readCsv`.
 */
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

/** The file could not be read as a supported workbook; `message` is safe to show the uploader. */
export class WorkbookReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookReadError';
  }
}

export interface WorkbookSnapshot {
  /** Every sheet name in tab order (a CSV has exactly one). */
  sheetNames: string[];
  /**
   * The FIRST sheet as a 2-D grid: every row padded to the sheet's used
   * width with `null`, fully blank rows dropped, merged cells resolved (see
   * the file header). Same shape `sheet_to_json({header:1, defval:null,
   * blankrows:false})` produced.
   */
  grid: unknown[][];
}

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const LEGACY_XLS_MESSAGE =
  'This looks like a legacy Excel (.xls) or password-protected workbook, which cannot be read. ' +
  'Open it in Excel, choose File > Save As > Excel Workbook (.xlsx) or CSV, and upload that instead.';

const HTML_XML_MESSAGE =
  'This file is an HTML/XML export saved with a spreadsheet extension, not a real Excel or CSV file. ' +
  'Open it in Excel, choose File > Save As > Excel Workbook (.xlsx) or CSV, and upload that instead.';

// The route reads one upload up to three times (template parse, grid rebuild,
// other-sheet listing). Loading a workbook is by far the costliest step, so
// the result is memoised per Buffer OBJECT: the same upload reads once, and
// every later upload (a new Buffer) reads fresh. A rejected load is memoised
// too, so repeat callers see the same error a re-read would give.
const cache = new WeakMap<Buffer, Promise<WorkbookSnapshot>>();

export function readWorkbook(buffer: Buffer): Promise<WorkbookSnapshot> {
  let snapshot = cache.get(buffer);
  if (!snapshot) {
    snapshot = load(buffer);
    cache.set(buffer, snapshot);
  }
  return snapshot;
}

async function load(buffer: Buffer): Promise<WorkbookSnapshot> {
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return readXlsx(buffer); // "PK" zip container
  if (buffer.length >= OLE2_MAGIC.length && buffer.subarray(0, OLE2_MAGIC.length).equals(OLE2_MAGIC)) {
    throw new WorkbookReadError(LEGACY_XLS_MESSAGE);
  }
  return readCsv(buffer);
}

// --- .xlsx ---------------------------------------------------------------

async function readXlsx(buffer: Buffer): Promise<WorkbookSnapshot> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs types `load` as taking its own `Buffer extends ArrayBuffer`
    // interface, which Node's Buffer does not satisfy; it accepts a Node
    // Buffer at runtime.
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw new WorkbookReadError((err as Error).message);
  }
  const sheets = workbook.worksheets;
  return { sheetNames: sheets.map((s) => s.name), grid: sheets[0] ? sheetToGrid(sheets[0]) : [] };
}

/** Column letters -> 1-based index ("A" -> 1, "AA" -> 27). */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Addresses of every cell that must read as BLANK because it sits inside a
 * merge spanning more than one ROW (other than that merge's top-left master).
 *
 * The old SheetJS `expandMergedCells` expanded HORIZONTAL merges only
 * (spanning columns within one row) and deliberately skipped any merge with
 * `e.r > s.r`: every genuine merge this app has seen in a reference fixture is
 * horizontal (a day header across AM/PM columns, a role banner across the
 * staff block), while a vertical merge has no legitimate case here (round-2
 * audit) and is a real authoring pattern instead — a manager vertically
 * merges a staff-name cell across several rows for visual grouping, each row
 * still carrying that OWN row's real, DIFFERENT shifts. Expanding it would
 * silently attribute all of them to the merge's top-left name; leaving the
 * covered cells blank lets `deterministicGridParser.ts`'s
 * 'unrecognized_merged_name_cell' handling surface them instead of dropping
 * them silently. exceljs resolves every merged cell to its master's value, so
 * that rule has to be re-imposed explicitly.
 */
function multiRowMergeSlaves(ws: ExcelJS.Worksheet): Set<string> {
  const slaves = new Set<string>();
  if (!ws.hasMerges) return slaves; // the common case: skip building the model
  for (const range of ws.model.merges as string[]) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (!m) continue;
    const [left, top, right, bottom] = [columnNumber(m[1]), Number(m[2]), columnNumber(m[3]), Number(m[4])];
    if (bottom <= top) continue; // single-row (horizontal) merge: expanded, as before
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        if (r === top && c === left) continue;
        slaves.add(`${r}:${c}`);
      }
    }
  }
  return slaves;
}

/**
 * exceljs cell value -> the plain scalar `sheet_to_json` (raw mode) returned:
 *  - string / number / boolean / Date        -> as is (dates are UTC-based
 *    `Date`s, which is how the parsers read them — see `parseDateCell`)
 *  - formula                                 -> its cached result, normalised
 *  - rich text                               -> concatenated run text
 *  - hyperlink                               -> its display text
 *  - error (#N/A, #REF!, ...)                -> null
 *  - anything else                           -> null
 */
export function normalizeCellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  const v = value as unknown as Record<string, unknown>;
  if ('error' in v) return null;
  if ('formula' in v || 'sharedFormula' in v) return normalizeCellValue(v.result as ExcelJS.CellValue);
  if (Array.isArray(v.richText)) return (v.richText as { text: string }[]).map((run) => run.text).join('');
  if ('hyperlink' in v) return normalizeCellValue(v.text as ExcelJS.CellValue);
  return null;
}

/**
 * exceljs cannot read ISO-8601 date cells (`t="d"`, `<v>2026-08-17T00:00:00Z</v>`),
 * which SheetJS's writer (`cellDates`) and openpyxl (`iso_dates`) produce:
 * it `parseFloat`s the text — giving the YEAR, 2026 — and then applies the
 * cell's date format, so the cell silently reads as 1905-07-18. The real date
 * cannot be recovered from that value, and a wrong date is worse than a
 * refusal, so recognise the signature and fail loudly instead. A year-number
 * of 1828-2342 is what any real roster date turns into (1905-01-01 up to
 * 1906-06-01); no real roster has a date there, and it is far from anything a
 * genuine elapsed-time total ([h]:mm, a few days at most) can reach. Skipped
 * for the 1904 date system, whose serials map differently.
 */
const MISREAD_ISO_DATE_FROM = Date.UTC(1905, 0, 1);
const MISREAD_ISO_DATE_TO = Date.UTC(1906, 5, 1);

function assertNotMisreadIsoDate(value: Date, address: string, date1904: boolean): void {
  if (date1904) return;
  const t = value.getTime();
  if (t >= MISREAD_ISO_DATE_FROM && t < MISREAD_ISO_DATE_TO) {
    throw new WorkbookReadError(
      `Cell ${address} holds an ISO-8601 (t="d") date, a format this reader cannot read reliably. ` +
        'Open the file in Excel, LibreOffice or Google Sheets, re-save it as .xlsx, and upload that instead.',
    );
  }
}

function sheetToGrid(ws: ExcelJS.Worksheet): unknown[][] {
  const { left, right } = ws.dimensions;
  if (!left || !right) return []; // no cells at all
  const width = right - left + 1;
  const blanked = multiRowMergeSlaves(ws);
  const date1904 = ws.workbook.properties.date1904 === true;
  const grid: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: unknown[] = new Array<unknown>(width).fill(null);
    let hasValue = false;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (blanked.has(`${rowNumber}:${colNumber}`)) return;
      const value = normalizeCellValue(cell.value);
      if (value === null) return;
      if (value instanceof Date) assertNotMisreadIsoDate(value, cell.address, date1904);
      cells[colNumber - left] = value;
      hasValue = true;
    });
    if (hasValue) grid.push(cells); // blankrows:false
  });
  return grid;
}

// --- CSV ------------------------------------------------------------------

// Same candidates and tie-break weights as SheetJS's separator guess (comma
// wins ties, then tab, semicolon, pipe): a roster CSV exported from Excel in a
// regional locale is often semicolon- or tab-separated.
const CSV_SEPARATORS: Record<string, number> = { ',': 3, '\t': 2, ';': 1, '|': 0 };

function guessCsvSeparator(text: string): string {
  const explicit = /^sep=(.)/.exec(text); // Excel's own "sep=;" first line
  if (explicit) return explicit[1];
  const counts = new Map<string, number>();
  let inQuotes = false;
  for (const ch of text.slice(0, 1024)) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in CSV_SEPARATORS) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ',';
  let bestCount = 0;
  for (const [sep, n] of counts) {
    if (n > bestCount || (n === bestCount && CSV_SEPARATORS[sep] > CSV_SEPARATORS[best])) {
      best = sep;
      bestCount = n;
    }
  }
  return best;
}

/**
 * CSV cell text -> value. Numbers and TRUE/FALSE are typed; EVERYTHING else
 * stays a string — deliberately including date-looking text. The parsers'
 * `parseDateCell`/`parseTimeCell` read strings correctly and TZ-independently,
 * whereas a Date built here from local time would read a day early under any
 * UTC+ zone. A shift like "9-17" must stay text (it is not a date).
 */
function csvCellValue(text: string): unknown {
  if (text === '') return null;
  if (text === 'TRUE') return true;
  if (text === 'FALSE') return false;
  const trimmed = text.trim();
  if (trimmed !== '') {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return text; // includes whitespace-only text, which the parsers treat as blank
}

async function readCsv(buffer: Buffer): Promise<WorkbookSnapshot> {
  const decoded = buffer.toString('utf8');
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded; // strip a UTF-8 BOM
  if (/^\s*</.test(text)) throw new WorkbookReadError(HTML_XML_MESSAGE);
  const separator = guessCsvSeparator(text);
  const body = /^sep=./.test(text) ? text.replace(/^sep=.[^\n]*\n?/, '') : text;

  const workbook = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet;
  try {
    ws = await workbook.csv.read(Readable.from([body]), {
      sheetName: 'Sheet1',
      map: (value: unknown) => csvCellValue(String(value)),
      parserOptions: { delimiter: separator },
    } as Partial<ExcelJS.CsvReadOptions>);
  } catch (err) {
    throw new WorkbookReadError((err as Error).message);
  }
  return { sheetNames: [ws.name], grid: sheetToGrid(ws) };
}
