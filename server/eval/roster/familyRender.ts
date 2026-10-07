/**
 * Renders a semantic roster (families.ts) into the file a manager would upload: XLSX, CSV, a
 * text-layer PDF (Chromium print), a PNG screenshot, or an image-only PDF (the screenshot(s)
 * embedded with pdf-lib — no text layer, like a scan). Tooling only: uses devDependencies
 * (@playwright/test, pdf-lib), never imported by server code.
 */
import * as XLSXNS from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { dayHeaderLines, rng, shiftText, subCells, type SemanticRoster } from './families.js';

const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;

export interface PrintedCell {
  text: string;
  span: number;
  fill?: string;
  color?: string;
  bold?: boolean;
  center?: boolean;
  /** Right-aligned (a spreadsheet's numbers); overrides `center`. */
  right?: boolean;
  rotate?: boolean;
  /** Numeric value for spreadsheets (decimal hours are numbers in the source workbook). */
  num?: number;
  /** Text longer than the cell runs on into the next cells (left-aligned, not clipped), as a spreadsheet prints it. */
  runOn?: boolean;
}
export type RowKind = 'title' | 'header' | 'subheader' | 'caption' | 'spacer' | 'banner' | 'person' | 'headcount' | 'total' | 'footer';
export interface PrintedRow {
  kind: RowKind;
  page: number;
  cells: PrintedCell[];
  /** Legend entry printed to the right of this row (Family A colour key). */
  side?: { fill: string; label: string };
  tall?: boolean;
}
export interface PrintedSheet {
  columns: number;
  colWidths: number[];
  rows: PrintedRow[];
  pages: number;
}

/** A cell's alignment as the renderer prints it (centred by default). */
const align = (a: 'left' | 'center' | 'right' | undefined): Pick<PrintedCell, 'center' | 'right'> => (a === 'right' ? { right: true } : a === 'left' ? {} : { center: true });

const BLUE = '#a9c4eb';
const SALMON = '#fde0d0';
const ORANGE = '#f5bf42';
const NAVY = '#24305e';
const GOLD = '#f2d675';
const B_FILLS: Record<string, string> = { OFF: '#ffff3d', UL: '#f09cf0', AL: '#7030a0', SL: '#f09cf0', PH: '#5bb3f0' };
const B_SHIFT_FILLS = ['#e8352b', '#7fb04f', '#5bb3f0', '#5bb3f0', '#e8352b', '#7fb04f'];

/** The page a non-person row belongs to: the page of the next person row (or the previous one). */
function assignPages(rows: PrintedRow[]): void {
  let next = rows.length ? rows[rows.length - 1]!.page : 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.kind === 'person') next = rows[i]!.page;
    else if (rows[i]!.kind === 'headcount') rows[i]!.page = rows[i - 1]?.page ?? next;
    else if (rows[i]!.kind !== 'footer') rows[i]!.page = Math.min(rows[i]!.page, next);
  }
}

export function printedSheet(roster: SemanticRoster): PrintedSheet {
  const { spec } = roster;
  const r = rng(spec.seed + 7);
  const rows: PrintedRow[] = [];
  const headerLines = roster.dates.map((iso, d) => dayHeaderLines(spec, iso, d));
  const lineCount = headerLines[0]!.length;

  if (spec.family === 'A') {
    const columns = 1 + 28;
    const dayCells = (text: (d: number) => string, extra: Partial<PrintedCell> = {}) => roster.dates.map((_, d) => ({ text: text(d), span: 4, ...align(spec.headerAlign), ...extra }));
    if (roster.title) rows.push({ kind: 'title', page: 1, cells: [{ text: roster.title, span: columns, bold: true, center: true }] });
    for (let l = 0; l < lineCount; l++) {
      const isDateLine = /\d/.test(headerLines[0]![l]!);
      rows.push({
        kind: 'header',
        page: 1,
        tall: spec.rotateWeekdays && !/\d/.test(headerLines[0]![l]!),
        cells: [{ text: '', span: 1 }, ...dayCells((d) => headerLines[d]![l]!, { fill: isDateLine ? SALMON : undefined, rotate: spec.rotateWeekdays && !isDateLine })],
      });
    }
    rows.push({ kind: 'subheader', page: 1, cells: [{ text: '', span: 1 }, ...roster.dates.flatMap(() => [{ text: 'AM', span: 2, center: true }, { text: 'PM', span: 2, center: true }])] });
    rows.push({
      kind: 'caption',
      page: 1,
      cells: [{ text: 'COVERS', span: 1, center: true }, ...roster.dates.flatMap((_, d) => [{ text: roster.covers[d] ?? '', span: 2, fill: roster.covers[d] ? '#ffff00' : undefined }, { text: '', span: 2 }])],
    });
    let groupIndex = -1;
    let group: typeof roster.people = [];
    const flushHeadcount = () => {
      if (!group.length) return;
      const page = group[group.length - 1]!.page;
      rows.push({
        kind: 'headcount',
        page,
        cells: [
          { text: String(group.length), span: 1, bold: true, center: true, num: group.length },
          ...roster.dates.flatMap((_, d) => {
            const am = group.filter((p) => { const c = p.cells[d]!; return c.kind === 'shift' && c.segs.some(([s]) => s < 14 * 60); }).length;
            const pm = group.filter((p) => { const c = p.cells[d]!; return c.kind === 'shift' && c.segs.some(([s]) => s >= 14 * 60); }).length;
            return [{ text: String(am), span: 2, bold: true, center: true, num: am }, { text: String(pm), span: 2, bold: true, center: true, num: pm }];
          }),
        ],
      });
      group = [];
    };
    for (const p of roster.people) {
      if (p.group !== groupIndex) {
        flushHeadcount();
        rows.push({ kind: 'banner', page: p.page, cells: [{ text: '', span: 1 }, { text: p.section ?? '', span: 28, fill: BLUE, center: true }] });
        groupIndex = p.group;
      }
      const cells: PrintedCell[] = [{ text: p.name, span: 1, center: true }];
      p.cells.forEach((c, d) => {
        if (c.kind === 'shift') {
          const fill = p.shiftFills[d] ?? undefined;
          for (const t of subCells(spec.notation, c.segs)) cells.push({ text: t, span: 1, fill, ...align(spec.dayAlign), color: fill === '#ff0000' ? '#ffffff' : undefined, num: t && spec.notation === 'decimal' ? Number(t) : undefined });
        } else {
          const fill = c.kind === 'colour' ? roster.legend.find((l) => l.label === c.meaning)?.fill : undefined;
          for (let k = 0; k < 4; k++) cells.push({ text: '', span: 1, fill });
        }
      });
      rows.push({ kind: 'person', page: p.page, cells });
      group.push(p);
    }
    flushHeadcount();
    if (spec.totalsFooter) {
      // Everyone on the rota, and how many work each half-day: a totals line, never a person.
      const count = (d: number, am: boolean) => roster.people.filter((p) => { const c = p.cells[d]!; return c.kind === 'shift' && c.segs.some(([s]) => (s < 14 * 60) === am); }).length;
      rows.push({
        kind: 'total',
        page: spec.pages,
        cells: [
          { text: `Total staff on rota ${roster.people.length}`, span: 1, bold: true },
          ...roster.dates.flatMap((_, d) => [{ text: String(count(d, true)), span: 2, bold: true, center: true, num: count(d, true) }, { text: String(count(d, false)), span: 2, bold: true, center: true, num: count(d, false) }]),
        ],
      });
    }
    for (const text of spec.footerLines ?? []) rows.push({ kind: 'footer', page: spec.pages, cells: [{ text, span: columns }] });
    if (spec.footer) rows.push({ kind: 'footer', page: spec.pages, cells: [{ text: `Prepared by: Duty Manager    Printed ${roster.dates[0]}    Page ${spec.pages} of ${spec.pages}`, span: columns }] });
    for (const [label, days] of spec.signOffRows ?? []) rows.push({ kind: 'footer', page: spec.pages, cells: [{ text: label, span: 1 }, ...roster.dates.map((_, d) => ({ text: days[d] ?? '', span: 4 }))] });
    // The colour key sits to the right of the grid, one entry per row from the COVERS row on.
    const firstSide = rows.findIndex((x) => x.kind === 'caption') + 1;
    roster.legend.forEach((l, i) => {
      const row = rows[firstSide + i];
      if (row) row.side = l;
    });
    assignPages(rows);
    return { columns, colWidths: [150, ...Array(28).fill(34)], rows, pages: spec.pages };
  }

  // Family B
  const order: ('no' | 'name' | 'title')[] = spec.combined ? ['name'] : spec.lead ?? (spec.nameFirst ? ['name', 'title'] : ['title', 'name']);
  const nLead = order.length;
  const columns = nLead + 7;
  const labels = spec.leadLabels ?? (spec.leadHeaders ? { name: 'NAME', title: 'TITLE' } : null);
  const leadAlign = spec.tightLead ? {} : { center: true };
  rows.push({ kind: 'title', page: 1, cells: [{ text: '', span: nLead, fill: NAVY }, { text: roster.title ?? '', span: 7, fill: NAVY, color: GOLD, bold: true, center: true }] });
  const head = (text: string, span: number): PrintedCell => ({ text, span, fill: '#fbe9b7', bold: true, center: true });
  const dayHead = (text: string): PrintedCell => ({ ...head(text, 1), center: false, ...align(spec.headerAlign) });
  for (let l = 0; l < lineCount; l++) {
    const line = headerLines.map((h) => h[l]!);
    const label = lineCount === 1 ? '' : /\d/.test(line[0]!) ? 'DATE' : 'DAY OF THE WEEK';
    // Column headings over the leading columns, in their printed order, on the first header row.
    const leadCells = labels && !spec.labelsRow ? order.map((k) => head(l === 0 ? labels[k] ?? '' : '', 1)) : [head(label, nLead)];
    rows.push({ kind: 'header', page: 1, cells: [...leadCells, ...line.map((t) => dayHead(t))] });
  }
  if (labels && spec.labelsRow) {
    rows.push({ kind: 'subheader', page: 1, cells: [...order.map((k) => ({ ...head(labels[k] ?? '', 1), center: false })), ...roster.dates.map(() => head('', 1))] });
  }
  rows.push({ kind: 'caption', page: 1, tall: true, cells: [{ text: 'Events', span: nLead, center: true }, ...roster.dates.map((_, d) => ({ text: roster.events[d] ?? '', span: 1, center: true, bold: true }))] });
  rows.push({ kind: 'spacer', page: 1, cells: [{ text: '', span: columns }] });
  let groupIndex = spec.departments || spec.areas ? -1 : 0;
  let index = 0;
  for (const p of roster.people) {
    if (p.group !== groupIndex) {
      const banner = p.section ?? '';
      rows.push({
        kind: 'banner',
        page: p.page,
        cells: spec.bannerInName
          ? [...order.map((k) => ({ text: k === 'name' ? banner : '', span: 1, bold: true })), ...roster.dates.map(() => ({ text: '', span: 1 }))]
          : [{ text: banner, span: columns, fill: ORANGE, color: '#ffffff', bold: true }],
      });
      groupIndex = p.group;
    }
    index++;
    const combinedName = spec.combined === 'slash' ? `${p.name} / ${p.title ?? ''}` : `${p.name} (${p.title ?? ''})`;
    const leadText: Record<'no' | 'name' | 'title', string> = { no: String(index), name: spec.combined && p.title ? combinedName : p.name, title: p.title ?? '' };
    const cells: PrintedCell[] = order.map((k) => ({ text: leadText[k], span: 1, bold: k !== 'no', ...leadAlign }));
    const cellAlign = align(spec.dayAlign ?? (spec.narrowDays ? 'left' : 'center'));
    p.cells.forEach((c) => {
      if (c.kind === 'shift') {
        const idx = Math.floor(r() * B_SHIFT_FILLS.length);
        cells.push({ text: shiftText(spec.notation, c.segs, r), span: 1, ...cellAlign, fill: B_SHIFT_FILLS[idx], ...(spec.narrowDays ? { runOn: true } : {}) });
      } else if (c.kind === 'leave') cells.push({ text: c.code, span: 1, ...cellAlign, fill: B_FILLS[c.code] });
      else if (c.kind === 'open') cells.push({ text: c.text, span: 1, ...cellAlign, fill: /CL|close/i.test(c.text) ? '#e8352b' : '#9bd16b' });
      else if (c.kind === 'unreadable') cells.push({ text: '', span: 1, fill: '#000000' });
      else cells.push({ text: '', span: 1 });
    });
    rows.push({ kind: 'person', page: p.page, cells });
  }
  if (spec.totalsFooter) {
    const count = (d: number) => roster.people.filter((p) => p.cells[d]!.kind === 'shift').length;
    rows.push({ kind: 'total', page: spec.pages, cells: [{ text: `Total staff on rota: ${roster.people.length}`, span: nLead, bold: true }, ...roster.dates.map((_, d) => ({ text: String(count(d)), span: 1, bold: true, center: true, num: count(d) }))] });
  }
  for (const text of spec.footerLines ?? []) rows.push({ kind: 'footer', page: spec.pages, cells: [{ text, span: columns }] });
  if (spec.footer) rows.push({ kind: 'footer', page: spec.pages, cells: [{ text: 'Notes: UL = unpaid leave, AL = annual leave, CL = until close, IN = start time only', span: columns }] });
  for (const [label, days] of spec.signOffRows ?? []) rows.push({ kind: 'footer', page: spec.pages, cells: [...order.map((k) => ({ text: k === 'name' ? label : '', span: 1 })), ...roster.dates.map((_, d) => ({ text: days[d] ?? '', span: 1 }))] });
  assignPages(rows);
  const width: Record<'no' | 'name' | 'title', number> = spec.tightLead ? { no: 28, name: 128, title: 96 } : { no: 40, name: 150, title: 110 };
  return { columns, colWidths: [...order.map((k) => (spec.combined && k === 'name' ? 230 : width[k])), ...Array(7).fill(spec.dayWidth ?? (spec.narrowDays ? 54 : 150))], rows, pages: spec.pages };
}

// --- spreadsheets ----------------------------------------------------------------------------

function aoa(sheet: PrintedSheet, numeric: boolean): { rows: (string | number)[][]; merges: XLSXNS.Range[] } {
  const out: (string | number)[][] = [];
  const merges: XLSXNS.Range[] = [];
  for (const row of sheet.rows) {
    const cells: (string | number)[] = [];
    for (const c of row.cells) {
      if (c.span > 1) merges.push({ s: { r: out.length, c: cells.length }, e: { r: out.length, c: cells.length + c.span - 1 } });
      cells.push(numeric && c.num !== undefined ? c.num : c.text);
      for (let k = 1; k < c.span; k++) cells.push('');
    }
    if (row.side) cells.push('', row.side.label);
    out.push(cells);
  }
  return { rows: out, merges };
}

export function renderXlsx(sheet: PrintedSheet): Buffer {
  const { rows, merges } = aoa(sheet, true);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rota');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function renderCsv(sheet: PrintedSheet): Buffer {
  const { rows } = aoa(sheet, true);
  return Buffer.from(XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(rows)));
}

// --- HTML (CSS grid, one container per page) ----------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One HTML document; `onlyPage` renders a single page container (for screenshots). */
export function sheetHtml(sheet: PrintedSheet, opts: { shuffle: boolean; repeatHeader: boolean; seed: number; onlyPage?: number }): string {
  const r = rng(opts.seed + 13);
  const sideCols = sheet.rows.some((x) => x.side) ? [16, 26, 84] : [];
  const widths = [...sheet.colWidths, ...sideCols];
  const pageNumbers = Array.from({ length: sheet.pages }, (_, i) => i + 1).filter((p) => !opts.onlyPage || p === opts.onlyPage);
  const headerRows = sheet.rows.filter((x) => x.kind === 'title' || x.kind === 'header' || x.kind === 'subheader');
  const pages = pageNumbers.map((page) => {
    const rows = sheet.rows.filter((x) => x.page === page);
    const printed = page > 1 && opts.repeatHeader ? [...headerRows, ...rows] : rows;
    const divs: string[] = [];
    printed.forEach((row, ri) => {
      let col = 1;
      for (const c of row.cells) {
        const style = [
          `grid-row:${ri + 1}`,
          `grid-column:${col} / span ${c.span}`,
          c.fill ? `background:${c.fill}` : '',
          c.color ? `color:${c.color}` : '',
          c.bold ? 'font-weight:bold' : '',
          c.right ? 'justify-content:flex-end' : c.center ? 'justify-content:center' : '',
          c.runOn ? 'overflow:visible;z-index:1' : '',
          row.kind === 'person' || row.kind === 'headcount' || row.kind === 'header' || row.kind === 'subheader' ? 'border:1px solid #333' : 'border:1px solid #bbb',
        ].filter(Boolean).join(';');
        const inner = c.rotate ? `<span class="rot">${esc(c.text)}</span>` : esc(c.text);
        divs.push(`<div class="c" style="${style}">${inner}</div>`);
        col += c.span;
      }
      if (row.side) {
        divs.push(`<div class="c" style="grid-row:${ri + 1};grid-column:${col + 1};background:${row.side.fill};border:1px solid #333"></div>`);
        divs.push(`<div class="c" style="grid-row:${ri + 1};grid-column:${col + 2};border:1px solid #333;justify-content:center">${esc(row.side.label)}</div>`);
      }
    });
    if (opts.shuffle) {
      for (let i = divs.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [divs[i], divs[j]] = [divs[j]!, divs[i]!];
      }
    }
    const rowHeights = printed.map((x) => (x.tall ? (x.cells.some((c) => c.rotate) ? '64px' : '40px') : '19px')).join(' ');
    return `<section class="page"><div class="grid" style="grid-template-columns:${widths.map((w) => `${w}px`).join(' ')};grid-template-rows:${rowHeights}">${divs.join('')}</div></section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;background:#fff}
    .page{padding:24px;break-after:page;width:max-content}
    .page:last-child{break-after:auto}
    .grid{display:grid}
    .c{display:flex;align-items:center;padding:0 3px;white-space:nowrap;overflow:hidden;box-sizing:border-box;margin:0 -1px -1px 0}
    .rot{writing-mode:vertical-rl;transform:rotate(180deg)}
  </style></head><body>${pages.join('')}</body></html>`;
}

// --- Chromium output ---------------------------------------------------------------------------

type Browser = Awaited<ReturnType<typeof import('@playwright/test').chromium.launch>>;
let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
  }
  return browser;
}
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

export async function renderTextPdf(sheet: PrintedSheet, opts: { shuffle: boolean; repeatHeader: boolean; seed: number }): Promise<Buffer> {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(sheetHtml(sheet, opts));
    // A string, so this server-side file needs no DOM typings.
    const size = (await page.evaluate(
      `(() => { const pages = [...document.querySelectorAll('.page')]; return { w: Math.max(...pages.map((p) => p.offsetWidth)), h: Math.max(...pages.map((p) => p.offsetHeight)) }; })()`,
    )) as { w: number; h: number };
    return await page.pdf({ width: `${size.w + 2}px`, height: `${size.h + 2}px`, printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
  } finally {
    await page.close();
  }
}

export async function renderPngPages(sheet: PrintedSheet, opts: { shuffle: boolean; repeatHeader: boolean; seed: number }): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (let p = 1; p <= sheet.pages; p++) {
    const page = await (await getBrowser()).newPage({ deviceScaleFactor: 1.5 });
    try {
      await page.setContent(sheetHtml(sheet, { ...opts, onlyPage: p }));
      out.push(await (await page.$('.page'))!.screenshot());
    } finally {
      await page.close();
    }
  }
  return out;
}

/** An image-only PDF (no text layer): each PNG becomes one page, like a scan. */
export async function imagePdf(pngs: Buffer[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const png of pngs) {
    const img = await doc.embedPng(png);
    const page = doc.addPage([img.width / 1.5, img.height / 1.5]);
    page.drawImage(img, { x: 0, y: 0, width: img.width / 1.5, height: img.height / 1.5 });
  }
  return Buffer.from(await doc.save());
}

/**
 * A text-layer PDF as some spreadsheet exports write it: every cell is its own text run, and
 * the ff / fi / fl ligatures of a name come out as separate text items placed edge to edge
 * ("Sa" + "ffi" + "ya"), the way glyph-by-glyph exporters emit them. One page.
 */
export async function renderSplitLigaturePdf(sheet: PrintedSheet): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 8;
  const pt = 0.75; // CSS px -> PDF points
  const rowH = 19 * pt;
  const widths = sheet.colWidths.map((w) => w * pt);
  const width = widths.reduce((a, b) => a + b, 0) + 36;
  const height = sheet.rows.length * rowH + 36;
  const page = doc.addPage([width, height]);
  sheet.rows.forEach((row, ri) => {
    const y = height - 18 - (ri + 1) * rowH + 4;
    let col = 0;
    for (const cell of row.cells) {
      const x0 = 18 + widths.slice(0, col).reduce((a, b) => a + b, 0);
      const w = widths.slice(col, col + cell.span).reduce((a, b) => a + b, 0);
      col += cell.span;
      if (!cell.text) continue;
      const total = font.widthOfTextAtSize(cell.text, size);
      let x = cell.right ? x0 + w - 3 - total : cell.center ? x0 + (w - total) / 2 : x0 + 3;
      for (const piece of cell.text.split(/(ffi|ffl|ff|fi|fl)/).filter(Boolean)) {
        page.drawText(piece, { x, y, size, font });
        x += font.widthOfTextAtSize(piece, size);
      }
    }
  });
  return Buffer.from(await doc.save());
}
