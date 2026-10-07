/**
 * Positional PDF table reconstruction — reads a text-layer PDF's text items
 * with their real positions (via pdfjs-dist) and rebuilds the roster grid, so
 * a text-layer PDF goes through the exact same deterministic grid parser as
 * Excel/CSV (deterministicGridParser.ts) — the "table reader" that
 * cross-checks the AI reader.
 *
 * This only works for PDFs with a real extractable text layer — a scanned
 * or photographed roster has no positioned text items at all (0 items),
 * which callers should detect and route to the vision/LLM path instead.
 *
 * Exported spreadsheets emit text in whatever order they like and drop empty
 * cells entirely, so nothing here relies on item order or item counts — only
 * on geometry:
 *  1. Every item's bounding box from its transform (rotated header text too);
 *     items cluster into rows by vertical centre, and adjacent items closer
 *     than a space become one phrase ("Bin Rashed", "MONDAY 17 AUGUST").
 *  2. The day-header row(s) (weekday / date phrases, weekDetection.ts) give
 *     one centre per day; the days' column bands are the midpoints between
 *     neighbouring centres, so centred, left- or right-aligned text all lands
 *     in its own day. An AM | PM row under the days splits each band in two.
 *  3. Left of the first day band (name / title columns) and right of the
 *     last (notes, a colour key), columns are the vertical channels of text
 *     shared by the body rows — a banner or caption crossing the gap in one
 *     row doesn't merge them.
 *  4. A row with content in exactly one column, sitting unusually close
 *     beneath the previous row, is a wrapped continuation line of that cell.
 * A page without its own header reuses the geometry of the last page that
 * had one (continuation pages). Rows keep their page and row number.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { isConsecutiveDayRun, parseDayLabel, type DayLabel } from './weekDetection.js';

// Points pdfjs at its bundled standard-font metrics so it can measure
// non-embedded standard fonts (Helvetica, etc.) without a network fetch or a
// noisy "Ensure that the standardFontDataUrl API parameter is provided"
// warning on every PDF that uses one.
const STANDARD_FONT_DATA_URL = new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href;

interface PositionedItem {
  text: string;
  /** Bounding box (PDF user space, y grows upward). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Font height. */
  height: number;
}

const cx = (i: { x0: number; x1: number }) => (i.x0 + i.x1) / 2;
const cy = (i: { y0: number; y1: number }) => (i.y0 + i.y1) / 2;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Thrown when the buffer handed to hasPdfTextLayer/extractPdfGrid isn't a
 * PDF pdfjs-dist can even open at all (0 bytes, or bytes that aren't a PDF
 * container) — distinct from a valid PDF that simply has no text layer or
 * no day-header row, which are "not this shape, try the next fallback"
 * cases, not malformed-input cases. See schedules.ts's upload route (issue
 * #19): this used to propagate as an untyped rejection all the way to the
 * route's generic catch-all, producing a 500 ("Unexpected error...") for
 * what is really a 422-shaped "this file is broken" case.
 */
export class MalformedPdfError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'MalformedPdfError';
  }
}

/** Positioned text items per page ([] for a page with no text layer at all). */
async function extractPositionedItems(buffer: Buffer): Promise<PositionedItem[][]> {
  const data = new Uint8Array(buffer);
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  } catch (err) {
    throw new MalformedPdfError(err instanceof Error ? err.message : 'This file could not be read as a PDF.', err);
  }
  const pages: PositionedItem[][] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: PositionedItem[] = [];
      for (const raw of content.items) {
        if (!('str' in raw)) continue; // marked-content markers, not text
        const text = raw.str;
        if (!text || !text.trim()) continue;
        const [a, b, c, d, e, f] = raw.transform as number[];
        // The text runs along (a, b) for `width` and rises along (c, d) for `height`.
        const along = Math.hypot(a!, b!) || 1;
        const up = Math.hypot(c!, d!) || 1;
        const height = raw.height || up;
        const dx = (a! / along) * raw.width;
        const dy = (b! / along) * raw.width;
        const ux = (c! / up) * height;
        const uy = (d! / up) * height;
        const xs = [e!, e! + dx, e! + ux, e! + dx + ux];
        const ys = [f!, f! + dy, f! + uy, f! + dy + uy];
        items.push({ text: text.trim(), x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), height });
      }
      pages.push(items);
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

type Phrase = PositionedItem;
interface RowCluster {
  y: number;
  /** Text items as the PDF holds them: one per printed cell in spreadsheet exports. */
  items: PositionedItem[];
  /** Neighbouring items closer than a space, joined (a label split into words reads whole). */
  phrases: Phrase[];
}

/** Groups items into rows by vertical centre, then joins neighbours closer than a space into phrases. */
function clusterRows(items: PositionedItem[]): RowCluster[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => cy(b) - cy(a));
  const medianHeight = median(sorted.map((i) => i.height)) || 8;
  const tolerance = medianHeight * 0.6;
  const rows: { y: number; items: PositionedItem[] }[] = [];
  for (const item of sorted) {
    const current = rows[rows.length - 1];
    if (current && Math.abs(current.y - cy(item)) <= tolerance) current.items.push(item);
    else rows.push({ y: cy(item), items: [item] });
  }
  return rows.map((row) => {
    const phrases: Phrase[] = [];
    for (const item of [...row.items].sort((a, b) => a.x0 - b.x0)) {
      const prev = phrases[phrases.length - 1];
      if (prev && item.x0 - prev.x1 < medianHeight * 0.6) {
        prev.text = `${prev.text} ${item.text}`;
        prev.x1 = Math.max(prev.x1, item.x1);
        prev.y0 = Math.min(prev.y0, item.y0);
        prev.y1 = Math.max(prev.y1, item.y1);
      } else {
        phrases.push({ ...item });
      }
    }
    return { y: row.y, items: row.items, phrases };
  });
}

/** Day labels of a row when it is a day-header row (same rules as the grid parser's), else null. */
function headerDaysOf(parts: Phrase[]): { phrase: Phrase; label: DayLabel }[] | null {
  const days = parts.map((phrase) => ({ phrase, label: parseDayLabel(phrase.text) })).filter((d): d is { phrase: Phrase; label: DayLabel } => d.label !== null);
  if (days.length < 2) return null;
  // A leading label ("Name", "DATE", "DAY OF THE WEEK") may sit before the days.
  if (parts.length - days.length > Math.max(1, Math.floor(parts.length * 0.4))) return null;
  if (days.every((d) => d.label.numericOnly) && !isConsecutiveDayRun(days.map((d) => d.label))) return null;
  return days.sort((a, b) => cx(a.phrase) - cx(b.phrase));
}
/** Whole items first (one per printed cell); words joined into phrases when a label is split. */
const headerDays = (row: RowCluster) => headerDaysOf(row.items) ?? headerDaysOf(row.phrases);

const isPeriodRow = (row: RowCluster) => row.items.length >= 2 && row.items.filter((p) => /^(am|pm)$/i.test(p.text)).length / row.items.length >= 0.6;

interface Band {
  x0: number;
  x1: number;
}

interface Geometry {
  /** Columns left of the days (title / name), the day (half-)bands, then columns right of the days. */
  columns: Band[];
  /** For each day, the indexes of its columns in `columns` (two when split into AM | PM). */
  dayColumnIndexes: number[][];
}

/** Vertical channels of text shared by the body rows inside [lo, hi): the columns of that region. */
function textChannels(rows: RowCluster[], lo: number, hi: number): Band[] {
  const inside = rows.map((r) => r.items.filter((p) => cx(p) >= lo && cx(p) < hi)).filter((ps) => ps.length > 0);
  if (inside.length === 0) return [];
  const start = Math.floor(Math.min(...inside.flat().map((p) => p.x0)));
  const end = Math.ceil(Math.max(...inside.flat().map((p) => p.x1)));
  const counts = new Array(end - start + 1).fill(0) as number[];
  for (const phrases of inside) {
    const covered = new Set<number>();
    for (const p of phrases) for (let x = Math.floor(p.x0); x <= Math.ceil(p.x1); x++) covered.add(x - start);
    for (const x of covered) if (x >= 0 && x < counts.length) counts[x]!++;
  }
  // A channel is text most rows share; a gap crossed by one banner or caption is still a gap.
  const minCount = inside.length >= 4 ? Math.max(2, Math.ceil(inside.length * 0.08)) : 1;
  const bands: Band[] = [];
  let open: number | null = null;
  for (let i = 0; i <= counts.length; i++) {
    const on = i < counts.length && counts[i]! >= minCount;
    if (on && open === null) open = i;
    if (!on && open !== null) {
      bands.push({ x0: start + open, x1: start + i - 1 });
      open = null;
    }
  }
  return bands.length ? bands : [{ x0: start, x1: end }];
}

/** Column geometry from a page's header rows and body rows. */
function deriveGeometry(rows: RowCluster[], headerIdx: number, periodIdx: number | null, bodyStart: number): Geometry {
  const days = headerDays(rows[headerIdx]!)!;
  // One centre per printed day (a header merged across sub-columns prints once; repeats collapse).
  const centres: number[] = [];
  for (const d of days) {
    const c = cx(d.phrase);
    if (centres.length && Math.abs(c - centres[centres.length - 1]!) < 4) continue;
    centres.push(c);
  }
  const step = centres.length > 1 ? (centres[centres.length - 1]! - centres[0]!) / (centres.length - 1) : 90;
  const bands: Band[] = centres.map((c, i) => ({
    x0: i === 0 ? c - step / 2 : (centres[i - 1]! + c) / 2,
    x1: i === centres.length - 1 ? c + step / 2 : (c + centres[i + 1]!) / 2,
  }));
  const left = bands[0]!.x0;
  const right = bands[bands.length - 1]!.x1;
  const body = rows.slice(bodyStart);
  const leading = textChannels(body, -Infinity, left);
  const trailing = textChannels(body, right, Infinity);
  const columns: Band[] = leading.length ? [...leading] : [{ x0: left - 1, x1: left - 1 }];
  const dayColumnIndexes: number[][] = [];
  const period = periodIdx !== null ? rows[periodIdx]! : null;
  for (const band of bands) {
    const am = period?.items.find((p) => /^am$/i.test(p.text) && cx(p) >= band.x0 && cx(p) < band.x1);
    const pm = period?.items.find((p) => /^pm$/i.test(p.text) && cx(p) >= band.x0 && cx(p) < band.x1);
    if (am && pm && cx(am) < cx(pm)) {
      const split = (cx(am) + cx(pm)) / 2;
      dayColumnIndexes.push([columns.length, columns.length + 1]);
      columns.push({ x0: band.x0, x1: split }, { x0: split, x1: band.x1 });
    } else {
      dayColumnIndexes.push([columns.length]);
      columns.push(band);
    }
  }
  columns.push(...trailing);
  return { columns, dayColumnIndexes };
}

/** The column a phrase belongs to: the one containing its centre, else the nearest. */
function columnOf(p: Phrase, columns: Band[]): number {
  const c = cx(p);
  let best = 0;
  let bestDist = Infinity;
  columns.forEach((band, i) => {
    const dist = c < band.x0 ? band.x0 - c : c > band.x1 ? c - band.x1 : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/**
 * Merges a wrapped continuation line into the row above it. A row counts as
 * a continuation when: it has non-blank content in exactly one column, that
 * same column is already non-blank in the row above, and the vertical gap
 * from the row above is tighter than the page's typical row-to-row gap
 * (i.e. it sits unusually close beneath the previous row, the visual
 * signature of a wrapped second line rather than a genuine new row).
 */
function mergeContinuationLines(grid: string[][], rowYs: number[], refs: number[]): { grid: string[][]; refs: number[] } {
  if (grid.length < 2) return { grid, refs };
  const gaps = rowYs.slice(1).map((y, i) => rowYs[i] - y).filter((g) => g > 0);
  const typicalGap = median(gaps) || 1;

  const merged: string[][] = [grid[0]];
  const mergedYs: number[] = [rowYs[0]];
  const mergedRefs: number[] = [refs[0]!];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    const nonBlankCols = row.map((c, idx) => (c ? idx : -1)).filter((idx) => idx >= 0);
    const gapFromPrev = mergedYs[mergedYs.length - 1] - rowYs[i];
    const prev = merged[merged.length - 1];

    if (nonBlankCols.length === 1 && gapFromPrev < typicalGap * 0.75 && prev[nonBlankCols[0]] !== '') {
      const col = nonBlankCols[0];
      prev[col] = `${prev[col]} ${row[col]}`.trim();
      continue;
    }
    merged.push(row);
    mergedYs.push(rowYs[i]);
    mergedRefs.push(refs[i]!);
  }
  return { grid: merged, refs: mergedRefs };
}

export interface PdfTable {
  /** The reconstructed grid ([] when no page has a day-header row: not a day grid). */
  grid: string[][];
  /** Page (1-based) and row within that page (1-based, top to bottom) of each grid row. */
  rowRefs: { page: number; row: number }[];
  pageCount: number;
  /** Each page's text, row by row with cells separated by " | " — the text layer the AI reader cross-checks. */
  pageTexts: string[];
}

/**
 * Reconstructs the roster grid from a text-layer PDF buffer, page by page
 * (top to bottom, one grid), keeping each row's page and row number.
 */
export async function extractPdfTable(buffer: Buffer): Promise<PdfTable> {
  const pages = await extractPositionedItems(buffer);
  const grid: string[][] = [];
  const rowRefs: { page: number; row: number }[] = [];
  const pageTexts: string[] = [];
  let geometry: Geometry | null = null;
  let headerSeen = false;
  pages.forEach((items, pageIndex) => {
    const rows = clusterRows(items);
    pageTexts.push(rows.map((r) => r.phrases.map((p) => p.text).join(' | ')).join('\n'));
    if (rows.length === 0) return;
    // This page's own day header, if it prints one near the top.
    const headerIdx = rows.slice(0, 40).findIndex((r) => headerDays(r) !== null);
    let lastHeaderRow = -1;
    if (headerIdx >= 0) {
      let periodIdx: number | null = null;
      lastHeaderRow = headerIdx;
      for (let k = headerIdx + 1; k < Math.min(rows.length, headerIdx + 4); k++) {
        if (periodIdx === null && headerDays(rows[k]!)) lastHeaderRow = k;
        else if (periodIdx === null && isPeriodRow(rows[k]!)) {
          periodIdx = k;
          lastHeaderRow = k;
        } else break;
      }
      geometry = deriveGeometry(rows, headerIdx, periodIdx, lastHeaderRow + 1);
    }
    if (!geometry) return;
    const g: Geometry = geometry;
    // A header repeated on a later page (and any title above it) is printed again, not new data.
    const skipThrough = headerSeen ? lastHeaderRow : -1;
    if (headerIdx >= 0) headerSeen = true;
    const pageGrid: string[][] = [];
    const ys: number[] = [];
    const refs: number[] = [];
    rows.forEach((row, r) => {
      if (r <= skipThrough) return;
      const cells: string[][] = g.columns.map(() => []);
      const isHeader = headerIdx >= 0 && r >= headerIdx && r <= lastHeaderRow && headerDays(row) !== null;
      // Whole items, not phrases: neighbouring cells can sit closer than a space apart.
      for (const p of [...row.items].sort((a, b) => a.x0 - b.x0)) {
        const col = columnOf(p, g.columns);
        // A day header names the whole day: every half of a split day carries it.
        const day = isHeader ? g.dayColumnIndexes.find((idx) => idx.includes(col)) : undefined;
        for (const c of day ?? [col]) cells[c]!.push(p.text);
      }
      pageGrid.push(cells.map((c) => c.join(' ').trim()));
      ys.push(row.y);
      refs.push(r + 1);
    });
    const merged = mergeContinuationLines(pageGrid, ys, refs);
    grid.push(...merged.grid);
    rowRefs.push(...merged.refs.map((row) => ({ page: pageIndex + 1, row })));
  });
  return { grid, rowRefs, pageCount: pages.length, pageTexts };
}

/**
 * Reconstructs a 2D grid from a text-layer PDF buffer, suitable for the
 * same interpretation the Excel/CSV path uses (parseExcelGrid). Multi-page
 * PDFs are concatenated page-by-page (top to bottom, one grid).
 *
 * Returns an empty array when no page has a day-header row (a long-format
 * export, free text, or a scanned/image-only PDF) — callers should treat
 * that as "not this shape" and route elsewhere.
 */
export async function extractPdfGrid(buffer: Buffer): Promise<string[][]> {
  return (await extractPdfTable(buffer)).grid;
}

/** True when the PDF has a real, positioned text layer (not scanned/image-only). */
export async function hasPdfTextLayer(buffer: Buffer): Promise<boolean> {
  const pages = await extractPositionedItems(buffer);
  return pages.some((p) => p.length > 0);
}

/** Number of pages (image-only PDFs included). */
export async function pdfPageCount(buffer: Buffer): Promise<number> {
  return (await extractPositionedItems(buffer)).length;
}
