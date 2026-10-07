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
 *     row doesn't merge them. Column labels printed near the day header
 *     ("NAME" | "POSITION", "#" | "EMPLOYEE") part columns set too close
 *     for a gap of their own, in whatever order they are printed.
 *  4. A row with content in exactly one column, sitting unusually close
 *     beneath the previous row, is a wrapped continuation line of that cell.
 * A page without its own header reuses the geometry of the last page that
 * had one (continuation pages). Rows keep their page and row number.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { isConsecutiveDayRun, parseDayLabel, type DayLabel } from './weekDetection.js';
import { columnHeading } from './personKey.js';

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

/**
 * What goes between two neighbouring text items: nothing when they touch (an exporter that
 * writes a word glyph run by glyph run splits "Saffiya" at its ligature into "Sa" + "ffi" +
 * "ya", edge to edge), a space otherwise.
 */
function glue(prev: PositionedItem, next: PositionedItem): string {
  return next.x0 - prev.x1 < Math.max(prev.height, next.height) * 0.12 ? '' : ' ';
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
        prev.text = `${prev.text}${glue(prev, item)}${item.text}`;
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
  // Column labels ("STAFF NAME", "POSITION", "#") don't count against it.
  const others = parts.filter((p) => !parseDayLabel(p.text) && !columnHeading(p.text)).length;
  if (others > Math.max(1, Math.floor(parts.length * 0.4))) return null;
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
  /** Left edge of the first day band: text from here on is day cells (or notes right of them). */
  daysFrom: number;
  /** Width of one day band. */
  step: number;
  /** How day cells sit in their columns: the edge (or centre) a cell's text keeps however long it is. */
  anchor: 'left' | 'centre' | 'right';
  /** Per day: where its cells' aligned edge sits (null when too few cells fit to tell). */
  edges: (number | null)[];
}

/** Mean distance from the median: how tightly a set of positions lines up. */
function spreadOf(values: number[]): number {
  const m = median(values);
  return values.reduce((sum, v) => sum + Math.abs(v - m), 0) / values.length;
}

/**
 * How the body's day cells are aligned: left (a spreadsheet's text cells), right (its number
 * cells) or centred — whichever edge the cells that fit their column keep in line. A long cell
 * that runs on past its column (a split shift in a narrow column) belongs to the column where
 * that edge is, not where its middle happens to fall.
 */
function dayCellAnchor(body: RowCluster[], columns: Band[], dayColumns: number[]): Pick<Geometry, 'anchor' | 'edges'> {
  const spreads: Record<Geometry['anchor'], number[]> = { left: [], centre: [], right: [] };
  const lefts: (number | null)[] = [];
  const rights: (number | null)[] = [];
  for (const c of dayColumns) {
    const band = columns[c]!;
    // Cells no wider than the column (its edges come from the header, which may sit off-centre).
    const fits = body.flatMap((r) => r.items).filter((p) => cx(p) >= band.x0 && cx(p) < band.x1 && p.x1 - p.x0 <= (band.x1 - band.x0) * 0.9);
    lefts.push(fits.length >= 3 ? median(fits.map((p) => p.x0)) : null);
    rights.push(fits.length >= 3 ? median(fits.map((p) => p.x1)) : null);
    if (fits.length < 3) continue;
    spreads.left.push(spreadOf(fits.map((p) => p.x0)));
    spreads.centre.push(spreadOf(fits.map(cx)));
    spreads.right.push(spreadOf(fits.map((p) => p.x1)));
  }
  const none = { anchor: 'centre' as const, edges: [] };
  if (spreads.centre.length < 2) return none;
  const [l, c, r] = [median(spreads.left), median(spreads.centre), median(spreads.right)];
  // Centred unless one edge lines up clearly better.
  if (c - l >= 0.5 && l <= r) return { anchor: 'left', edges: lefts };
  if (c - r >= 0.5 && r < l) return { anchor: 'right', edges: rights };
  return none;
}

/** Where a text item belongs across the page: its middle, or — for a day cell longer than its column — its aligned edge. */
function placeOf(p: PositionedItem, g: Pick<Geometry, 'daysFrom' | 'step' | 'anchor' | 'edges'>): number {
  const runsOn = p.x1 - p.x0 > g.step * 0.9 && cx(p) >= g.daysFrom;
  if (!runsOn || g.anchor === 'centre') return cx(p);
  // The day whose cells start (or end) where this one does: the header above it may be off-centre.
  const known = g.edges.filter((e): e is number => e !== null);
  if (g.anchor === 'left') {
    const edge = Math.max(...known.filter((e) => e <= p.x0 + 1.5));
    return Number.isFinite(edge) ? edge + g.step * 0.3 : p.x0 + 1;
  }
  const edge = Math.min(...known.filter((e) => e >= p.x1 - 1.5));
  return Number.isFinite(edge) ? edge - g.step * 0.3 : p.x1 - 1;
}

/** How many of the rows have text covering each x inside [lo, hi) (the rows' items whose centre is inside). */
function coverage(rows: RowCluster[], lo: number, hi: number): { start: number; counts: number[]; rowCount: number } | null {
  const inside = rows.map((r) => r.items.filter((p) => cx(p) >= lo && cx(p) < hi)).filter((ps) => ps.length > 0);
  if (inside.length === 0) return null;
  const start = Math.floor(Math.min(...inside.flat().map((p) => p.x0)));
  const end = Math.ceil(Math.max(...inside.flat().map((p) => p.x1)));
  const counts = new Array(end - start + 1).fill(0) as number[];
  for (const phrases of inside) {
    const covered = new Set<number>();
    for (const p of phrases) for (let x = Math.floor(p.x0); x <= Math.ceil(p.x1); x++) covered.add(x - start);
    for (const x of covered) if (x >= 0 && x < counts.length) counts[x]!++;
  }
  return { start, counts, rowCount: inside.length };
}

/** Vertical channels of text shared by the body rows inside [lo, hi): the columns of that region. */
function textChannels(rows: RowCluster[], lo: number, hi: number): Band[] {
  const cov = coverage(rows, lo, hi);
  if (!cov) return [];
  const { start, counts, rowCount } = cov;
  // A channel is text most rows share; a gap crossed by one banner or caption is still a gap.
  const minCount = rowCount >= 4 ? Math.max(2, Math.ceil(rowCount * 0.08)) : 1;
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
  return bands.length ? bands : [{ x0: start, x1: start + counts.length - 1 }];
}

/**
 * The column labels printed left of the days ("STAFF NAME" | "POSITION", "#" | "EMPLOYEE" |
 * "ROLE", "Position" | "S/N" | "Staff"), from the first row near the day header that holds two
 * or more of them and nothing else there: one centre per labelled column, in order. Two
 * neighbouring labels of the same kind ("FIRST NAME" | "LAST NAME") are one column.
 */
function leadingLabels(rows: RowCluster[], from: number, to: number, left: number): { x: number; kind: string }[] {
  for (let r = Math.max(0, from); r < Math.min(rows.length, to); r++) {
    const phrases = rows[r]!.phrases.filter((p) => cx(p) < left);
    const labels: { x: number; kind: string }[] = [];
    let onlyLabels = phrases.length > 0;
    for (const phrase of phrases) {
      const kind = columnHeading(phrase.text);
      if (kind) {
        labels.push({ x: cx(phrase), kind });
        continue;
      }
      // Labels printed closer than a space ("#EMPLOYEE") joined into one phrase: read item by item.
      const items = rows[r]!.items.filter((i) => i.x0 >= phrase.x0 - 0.5 && i.x1 <= phrase.x1 + 0.5);
      const kinds = items.map((i) => columnHeading(i.text));
      if (items.length > 1 && kinds.every(Boolean)) items.forEach((i, k) => labels.push({ x: cx(i), kind: kinds[k]! }));
      else onlyLabels = false;
    }
    if (!onlyLabels) continue;
    const merged = labels.sort((a, b) => a.x - b.x).filter((l, k, all) => k === 0 || l.kind !== all[k - 1]!.kind);
    if (merged.length >= 2) return merged;
  }
  return [];
}

/**
 * Splits leading channels that hold two labelled columns: between two neighbouring labels with
 * no column edge between them, the columns part where the body rows' text is thinnest. A name
 * column left-aligned against a title column (or a row number against a name) prints too close
 * for a gap of its own once a few long names or banners run across it.
 */
function splitByLabels(leading: Band[], labels: { x: number }[], body: RowCluster[], left: number): Band[] {
  let bands = [...leading];
  for (let k = 1; k < labels.length; k++) {
    const a = labels[k - 1]!.x;
    const b = labels[k]!.x;
    const separated = bands.some((band, i) => i > 0 && band.x0 > a && bands[i - 1]!.x1 < b);
    if (separated) continue;
    const cov = coverage(body, -Infinity, left);
    if (!cov) continue;
    // The widest run of x where the fewest rows have text.
    const xs: number[] = [];
    for (let x = Math.ceil(a) + 1; x < Math.floor(b); x++) xs.push(x);
    if (xs.length === 0) continue;
    const countAt = (x: number) => cov.counts[x - cov.start] ?? 0;
    const least = Math.min(...xs.map(countAt));
    let best: { from: number; to: number } | null = null;
    let run: { from: number; to: number } | null = null;
    for (const x of xs) {
      if (countAt(x) !== least) {
        run = null;
        continue;
      }
      run = run && run.to === x - 1 ? { from: run.from, to: x } : { from: x, to: x };
      if (!best || run.to - run.from > best.to - best.from) best = run;
    }
    if (!best) continue;
    const cut = (best.from + best.to) / 2;
    bands = bands.flatMap((band) => (band.x0 < cut && band.x1 > cut ? [{ x0: band.x0, x1: cut - 0.5 }, { x0: cut + 0.5, x1: band.x1 }] : [band]));
  }
  return bands;
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
  // Column labels near the day header ("NAME" | "POSITION", "#" | "EMPLOYEE") part columns printed too close for a gap.
  const leading = splitByLabels(textChannels(body, -Infinity, left), leadingLabels(rows, headerIdx - 3, bodyStart + 3, left), body, left);
  // Day cells' alignment, from the cells that fit their column (decided before the notes columns,
  // so a long Sunday cell running on past the grid is not a notes column).
  const dayBandIdx = bands.map((_, i) => i);
  const geo = { daysFrom: left, step, ...dayCellAnchor(body, bands, dayBandIdx) };
  const placed = body.map((row) => ({ ...row, items: row.items.filter((p) => placeOf(p, geo) >= right) }));
  const trailing = textChannels(placed, right, Infinity);
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
  return { columns, dayColumnIndexes, ...geo };
}

/** The column a phrase belongs to: the one containing its place (placeOf; else its centre), else the nearest. */
function columnOf(p: Phrase, columns: Band[], at: number = cx(p)): number {
  const c = at;
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
  /**
   * Rows (page and row, like rowRefs) holding a day cell longer than its column: which day it
   * belongs to was inferred from the column alignment, not read from where it sits.
   */
  runOnRows: { page: number; row: number }[];
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
  const runOnRows: { page: number; row: number }[] = [];
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
      const cells: PositionedItem[][] = g.columns.map(() => []);
      const isHeader = headerIdx >= 0 && r >= headerIdx && r <= lastHeaderRow && headerDays(row) !== null;
      // Whole items, not phrases: neighbouring cells can sit closer than a space apart.
      for (const p of [...row.items].sort((a, b) => a.x0 - b.x0)) {
        const col = isHeader ? columnOf(p, g.columns) : columnOf(p, g.columns, placeOf(p, g));
        // A day header names the whole day: every half of a split day carries it.
        const day = isHeader ? g.dayColumnIndexes.find((idx) => idx.includes(col)) : undefined;
        for (const c of day ?? [col]) cells[c]!.push(p);
      }
      pageGrid.push(cells.map((c) => c.reduce((text, item, k) => (k === 0 ? item.text : `${text}${glue(c[k - 1]!, item)}${item.text}`), '').trim()));
      ys.push(row.y);
      refs.push(r + 1);
      if (!isHeader && row.items.some((p) => p.x1 - p.x0 > g.step * 0.9 && cx(p) >= g.daysFrom)) runOnRows.push({ page: pageIndex + 1, row: r + 1 });
    });
    const merged = mergeContinuationLines(pageGrid, ys, refs);
    grid.push(...merged.grid);
    rowRefs.push(...merged.refs.map((row) => ({ page: pageIndex + 1, row })));
  });
  return { grid, rowRefs, pageCount: pages.length, pageTexts, runOnRows };
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
