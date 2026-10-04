/**
 * npm run eval:roster:generate — writes the eval corpus to server/eval/roster/corpus/:
 * `<id>.<ext>` (the roster as a manager would upload it) and `<id>.truth.json`.
 * Deterministic: re-running produces the same truth files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSXNS from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { CORPUS, DATES, MISMATCH_DAY, truthOf, type CorpusSpec, type DayHeaderStyle } from './spec.js';

const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
export const CORPUS_DIR = join('server', 'eval', 'roster', 'corpus');

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayHeaders(style: DayHeaderStyle): string[] {
  return DATES.map((iso, i) => {
    const [, m, d] = iso.split('-').map(Number) as [number, number, number];
    if (style === 'date') return `${d}-${MON[m - 1]}`;
    if (style === 'weekday') return WEEKDAYS[i]!;
    if (style === 'short-weekday') return SHORT[i]!;
    const dd = String(d).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    if (style === 'weekday-upper-dash') return `${SHORT[i]!.toUpperCase()} ${dd}-${mm}`;
    if (style === 'weekday-day-month') return `${SHORT[i]} ${d} ${MON[m - 1]}`;
    if (style === 'date-weekday') return `${dd}/${mm} ${SHORT[i]}`;
    if (style === 'weekday-date-mismatch' && i === MISMATCH_DAY) return `${SHORT[(i + 1) % 7]} ${dd}/${mm}`;
    return `${SHORT[i]} ${dd}/${mm}`;
  });
}

/** The day-grid as rows of strings: header, then section headers and staff rows. */
function gridRows(spec: CorpusSpec): string[][] {
  const rows: string[][] = [[spec.nameHeader, ...dayHeaders(spec.dayHeader)]];
  let section: string | null = null;
  for (const s of spec.staff) {
    if (spec.sectionHeaders && s.role !== section) {
      rows.push([s.role, ...DATES.map(() => '')]);
      section = s.role;
    }
    rows.push([s.name, ...s.cells]);
  }
  return rows;
}

function workbook(sheets: [string, XLSXNS.WorkSheet][]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of sheets) XLSX.utils.book_append_sheet(wb, ws, name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function pdfOf(rows: string[][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 560;
  for (const row of rows) {
    row.forEach((text, i) => text && page.drawText(text, { x: i === 0 ? 20 : 150 + (i - 1) * 85, y, size: 9, font }));
    y -= 22;
  }
  return Buffer.from(await doc.save());
}

export async function render(spec: CorpusSpec): Promise<{ file: string; data: Buffer }> {
  switch (spec.layout) {
    case 'grid':
      return { file: `${spec.id}.xlsx`, data: workbook([['Roster', XLSX.utils.aoa_to_sheet(gridRows(spec))]]) };
    case 'csv':
      return { file: `${spec.id}.csv`, data: Buffer.from(XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(gridRows(spec)))) };
    case 'pdf-text':
      return { file: `${spec.id}.pdf`, data: await pdfOf(gridRows(spec)) };
    case 'multi-sheet':
    case 'multi-sheet-notes-first': {
      const roster = XLSX.utils.aoa_to_sheet(gridRows(spec));
      const notes = XLSX.utils.aoa_to_sheet([['Notes'], ['Uniform check on Friday.'], ['Deliveries before 10.']]);
      const sheets: [string, XLSXNS.WorkSheet][] = spec.layout === 'multi-sheet' ? [['Roster', roster], ['Notes', notes]] : [['Notes', notes], ['Roster', roster]];
      return { file: `${spec.id}.xlsx`, data: workbook(sheets) };
    }
    case 'title-column': {
      const rows = [['', spec.nameHeader, ...dayHeaders(spec.dayHeader)], ...spec.staff.map((s) => [s.role, s.name, ...s.cells])];
      return { file: `${spec.id}.xlsx`, data: workbook([['Roster', XLSX.utils.aoa_to_sheet(rows)]]) };
    }
    case 'long-format': {
      const rows: (string | number)[][] = [['Employee Name', 'Role', 'Date', 'Start Time', 'End Time', 'Break (min)']];
      for (const t of truthOf(spec).shifts) rows.push([t.name, t.role, t.date, t.start, t.end, 0]);
      return { file: `${spec.id}.xlsx`, data: workbook([['Roster', XLSX.utils.aoa_to_sheet(rows)]]) };
    }
    case 'am-pm-merged': {
      const days = dayHeaders(spec.dayHeader);
      const rows: string[][] = [['', ...days.flatMap((d) => [d, d])], ['', ...days.flatMap(() => ['AM', 'PM'])]];
      let section: string | null = null;
      for (const s of spec.staff) {
        if (s.role !== section) {
          rows.push([s.role, ...days.flatMap(() => [s.role, s.role])]); // a merged banner repeats its label
          section = s.role;
        }
        rows.push([s.name, ...s.cells.flatMap((c) => c.split('|'))]);
      }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      // Day headers really merged across their AM/PM pair, as a spreadsheet would save them.
      ws['!merges'] = days.map((_, i) => ({ s: { r: 0, c: 1 + i * 2 }, e: { r: 0, c: 2 + i * 2 } }));
      return { file: `${spec.id}.xlsx`, data: workbook([['Roster', ws]]) };
    }
  }
}

export async function generateCorpus(dir = CORPUS_DIR): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const spec of CORPUS) {
    const { file, data } = await render(spec);
    writeFileSync(join(dir, file), data);
    writeFileSync(join(dir, `${spec.id}.truth.json`), `${JSON.stringify({ ...truthOf(spec), file, expectEscalation: spec.expectEscalation, tags: spec.tags }, null, 2)}\n`);
    written.push(file);
  }
  return written;
}

if (process.argv[1] && /generate\.ts$/.test(process.argv[1])) {
  const files = await generateCorpus();
  console.log(`[eval:roster] wrote ${files.length} rosters + truth files to ${CORPUS_DIR}`);
}
