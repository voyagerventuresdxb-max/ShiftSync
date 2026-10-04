/**
 * Child-process half of parserTimezoneMatrix.test.ts: parses the whole
 * spreadsheet corpus plus a set of synthetic CSV / HTML / typed-cell inputs
 * under whatever `TZ` this process was started with, and prints one JSON
 * document of every entry point's normalized output. The test runs it once
 * per timezone and asserts the documents are identical.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as XLSXNS from 'xlsx';
import { buildMergeExpandedGrid, gridToTsvText, listOtherSheetNames, parseWorkbookBuffer } from './parseWorkbook.js';
import { parseExcelGrid } from './deterministicGridParser.js';
import { parseRotaFile, processRowsIntoRoster } from './deterministicParser.js';

const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
const WEEK_START = '2026-08-17';
const FIXTURE_ROOT = 'server/test-fixtures';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(xlsx|xls|csv)$/i.test(name)) out.push(p);
  }
  return out.sort();
}

function safe<T>(fn: () => T): T | { error: string } {
  try {
    return fn();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Every entry point the upload route can reach, for one input. */
function probe(buffer: Buffer, name: string): Record<string, unknown> {
  const grid = safe(() => buildMergeExpandedGrid(buffer, name));
  const gridArr = Array.isArray(grid) ? grid : null;
  return {
    template: safe(() => parseWorkbookBuffer(buffer, name)),
    otherSheets: safe(() => listOtherSheetNames(buffer, name)),
    gridTextSha: gridArr ? createHash('sha256').update(gridToTsvText(gridArr)).digest('hex') : grid,
    gridText: gridArr && gridArr.length <= 12 ? gridToTsvText(gridArr) : undefined,
    deterministicGrid: gridArr ? safe(() => parseExcelGrid(gridArr, WEEK_START)) : grid,
    localRows: gridArr ? safe(() => processRowsIntoRoster(gridArr, WEEK_START)) : grid,
    // Slice the Buffer's OWN backing store: readFileSync can hand back a pooled Buffer
    // (byteOffset > 0), and a copy sliced at that offset is truncated garbage.
    rotaFile: safe(() => parseRotaFile(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, /\.csv$/i.test(name) ? 'csv' : 'xlsx', WEEK_START)),
  };
}

/** A typed-cell workbook written from serial NUMBERS only, so the bytes themselves are timezone-free. */
function typedWorkbook(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Employee Name', 'Role', 'Date', 'Start Time', 'End Time', 'Break (min)'],
    ['Ali Hassan', 'Bartender', 46254, 0.375, 0.7083333333333334, 30], // 2026-08-20, 09:00, 17:00
    ['Mona Said', 'Host', 46254, 0.75, 0.0416666666666667, 0], // 18:00 → 01:00 (overnight)
    ['Omar Farouk', 'Chef', 46255.5, 0.5, 0.9166666666666666, 45], // a date-time cell for the date
  ]);
  for (const a of ['C2', 'C3']) ws[a]!.z = 'd-mmm-yy';
  ws['C4']!.z = 'd/m/yyyy h:mm';
  for (const a of ['D2', 'E2', 'D3', 'E3', 'D4', 'E4']) ws[a]!.z = 'h:mm';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Roster');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: false }) as Buffer;
}

const synthetic: Record<string, Buffer> = {
  'long-format-month-names.csv': Buffer.from(
    'Employee Name,Role,Date,Start Time,End Time,Break (min)\n' +
      'Ali Hassan,Bartender,20-Aug-2026,9:00 AM,17:00,30\n' +
      'Mona Said,Host,20-Aug-26,18:00,1:00 AM,0\n' +
      'Omar Farouk,Chef,"Aug 21, 2026",09:00:00,5:00 PM,45\n' +
      'Sara Nour,Runner,2026-08-22,9 AM,17:00,0\n' +
      'Rami Toma,Runner,22-Aug-26,1:00 PM,9:00:00 PM,0\n' +
      'Tala Adel,Host,2026-08-23,21:00:00,23:30,0\n',
  ),
  'long-format.html.xls': Buffer.from(
    '<table><tr><td>Employee Name</td><td>Role</td><td>Date</td><td>Start Time</td><td>End Time</td><td>Break (min)</td></tr>' +
      '<tr><td>Ali Hassan</td><td>Bartender</td><td>20-Aug-2026</td><td>9:00 AM</td><td>5:00 PM</td><td>30</td></tr>' +
      '<tr><td>Mona Said</td><td>Host</td><td>21/08/2026</td><td>21:00:00</td><td>01:00</td><td>0</td></tr></table>',
  ),
  'grid-hour-ranges.csv': Buffer.from(
    ',Mon,Tue,Wed,Thu,Fri,Sat,Sun\n' +
      'Ali Hassan,10-18,9-17,,10-18,1-9,OFF,OFF\n' +
      'Mona Said,,14-22,14-22,OFF,,10-18,10-18\n',
  ),
  'typed-cells.xlsx': typedWorkbook(),
  // Day headers with a weekday before or after a DD/MM date; "Sat 21/08" is printed over a Friday.
  'grid-weekday-date-headers.csv': Buffer.from(
    ',Mon 17/08,TUE 18-08,Wed 19 Aug,20/08 Thu,Sat 21/08\n' +
      'SUPERVISORS,,,,,\n' +
      'Ali Hassan,9-17,9-17,OFF,10-18,10-18\n' +
      'Mona Said,14-22,,14-22,14-22,\n',
  ),
};

const out: Record<string, unknown> = { tz: process.env.TZ ?? null };
for (const file of walk(FIXTURE_ROOT)) out[file] = probe(readFileSync(file), file);
for (const [name, buffer] of Object.entries(synthetic)) out[`synthetic/${name}`] = probe(buffer, name);
process.stdout.write(JSON.stringify(out));
