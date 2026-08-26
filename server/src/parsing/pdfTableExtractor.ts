/**
 * Positional PDF table reconstruction — reads a text-layer PDF's characters
 * with their real x/y coordinates (via pdfjs-dist) and reconstructs a 2D
 * grid from them, so a text-layer PDF can be fed through the exact same
 * deterministic grid parser already built for Excel/CSV
 * (deterministicGridParser.ts) instead of a second bespoke parsing engine.
 *
 * This only works for PDFs with a real extractable text layer — a scanned
 * or photographed roster has no positioned text items at all (0 items),
 * which callers should detect and route to the vision/LLM path instead.
 *
 * Approach (deliberately simple, tuned empirically against the real
 * reference-venue PDF rather than over-engineered blind):
 *  1. Pull every text item's left-x and baseline-y from pdfjs-dist.
 *  2. Cluster items into rows by y-proximity, using a GAP from the
 *     previous row (not a fixed absolute grid) so gradual/inconsistent
 *     row spacing across the page doesn't break clustering.
 *  3. Derive column anchors from the header row's items, not every item on
 *     the page — a data row has far more positioned text items than visual
 *     columns (each raw number in a multi-value shift cell is its own
 *     item), so clustering from everything fragments one logical column
 *     into several spurious ones. The header row has exactly one item per
 *     real column, so it's a much more reliable anchor source.
 *  4. Assign each item to its nearest column anchor and its row.
 *  5. Post-process: a row with content in exactly one column, sitting
 *     unusually close beneath the previous row (tighter than the page's
 *     typical row spacing), is treated as a wrapped continuation line of
 *     that same cell (e.g. a role label wrapping to a second line) and
 *     merged into the row above instead of becoming its own row.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// Points pdfjs at its bundled standard-font metrics so it can measure
// non-embedded standard fonts (Helvetica, etc.) without a network fetch or a
// noisy "Ensure that the standardFontDataUrl API parameter is provided"
// warning on every PDF that uses one.
const STANDARD_FONT_DATA_URL = new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href;

interface PositionedItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Extracts positioned text items per page. Returns [] for a page with no text layer at all. */
async function extractPositionedItems(buffer: Buffer): Promise<PositionedItem[][]> {
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
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
        const transform = raw.transform as number[];
        items.push({ text, x: transform[4], y: transform[5], width: raw.width, height: raw.height });
      }
      pages.push(items);
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

interface RowCluster {
  y: number;
  items: PositionedItem[];
}

/** Groups items into rows by y-proximity, using the gap from the previous row (not a fixed grid). */
function clusterRows(items: PositionedItem[]): RowCluster[] {
  if (items.length === 0) return [];
  // PDF y grows upward — sort top of page first (descending y).
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const medianHeight = median(sorted.map((i) => i.height)) || 8;
  const tolerance = medianHeight * 0.6;

  const rows: RowCluster[] = [{ y: sorted[0].y, items: [sorted[0]] }];
  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const current = rows[rows.length - 1];
    if (Math.abs(current.y - item.y) <= tolerance) {
      current.items.push(item);
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }
  return rows;
}

const DAY_HEADER_RE = /^(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|\d{1,2}[-/][A-Za-z]{3,9}|\d{1,2}[-/]\d{1,2})$/i;

/**
 * Derives column anchors from a single "anchor row" instead of every item on
 * the page. A day-grid roster prints far more data items per row (each raw
 * number in a multi-segment shift cell is its own positioned text item) than
 * visual columns — clustering from all of them fragments one logical column
 * (e.g. a whole day's "11 17 18 25" cell) into several spurious ones. The
 * header row itself has exactly one item per visual day-column, so it's a
 * much more reliable source of true column boundaries; a name-column anchor
 * is prepended so the leftmost (staff name) column is captured too.
 */
function findAnchorRow(rows: RowCluster[]): RowCluster | null {
  for (const row of rows.slice(0, 10)) {
    const dayHits = row.items.filter((i) => DAY_HEADER_RE.test(i.text.trim())).length;
    if (dayHits >= 2) return row;
  }
  return null;
}

function deriveColumnAnchors(rows: RowCluster[]): number[] {
  const anchorRow = findAnchorRow(rows);
  const dayXs = anchorRow ? anchorRow.items.map((i) => i.x).sort((a, b) => a - b) : [];
  if (dayXs.length === 0) return [];

  // Name-column anchor: the absolute left edge (x=0), not an offset from
  // the first day column. Nearest-anchor assignment only cares about
  // relative distance, and a day's own data (left-aligned within its
  // column) can sit closer to a same-page-scaled offset anchor than to the
  // day header itself — x=0 keeps the name/day0 boundary at day0's true
  // midpoint instead of skewing it toward day0 and stealing its first value.
  const nameAnchor = 0;

  // Trailing anchor for whatever sits to the right of the last day column
  // (a notes/legend column is common on real rota exports) — without this,
  // that text gets pulled into the last day's cell and breaks its shift
  // parsing (e.g. "11.5 17 18 24 Closing" no longer matches a clean
  // 4-number cell).
  const deltas = dayXs.slice(1).map((x, i) => x - dayXs[i]);
  const avgDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 90;
  const trailingAnchor = dayXs[dayXs.length - 1] + avgDelta;

  return [nameAnchor, ...dayXs, trailingAnchor];
}

function nearestAnchorIndex(x: number, anchors: number[]): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const d = Math.abs(x - anchors[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Builds the raw (pre-continuation-merge) 2D grid from clustered rows + column anchors. */
function buildRawGrid(rows: RowCluster[], anchors: number[]): { grid: string[][]; rowYs: number[] } {
  const grid: string[][] = [];
  const rowYs: number[] = [];
  for (const row of rows) {
    const cells: PositionedItem[][] = anchors.map(() => []);
    for (const item of row.items) {
      cells[nearestAnchorIndex(item.x, anchors)].push(item);
    }
    grid.push(cells.map((itemsInCell) => itemsInCell.sort((a, b) => a.x - b.x).map((i) => i.text).join(' ').trim()));
    rowYs.push(row.y);
  }
  return { grid, rowYs };
}

/**
 * Merges a wrapped continuation line into the row above it. A row counts as
 * a continuation when: it has non-blank content in exactly one column, that
 * same column is already non-blank in the row above, and the vertical gap
 * from the row above is tighter than the page's typical row-to-row gap
 * (i.e. it sits unusually close beneath the previous row, the visual
 * signature of a wrapped second line rather than a genuine new row).
 */
function mergeContinuationLines(grid: string[][], rowYs: number[]): string[][] {
  if (grid.length < 2) return grid;
  const gaps = rowYs.slice(1).map((y, i) => rowYs[i] - y).filter((g) => g > 0);
  const typicalGap = median(gaps) || 1;

  const merged: string[][] = [grid[0]];
  const mergedYs: number[] = [rowYs[0]];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    const nonBlankCols = row.map((c, idx) => (c ? idx : -1)).filter((idx) => idx >= 0);
    const gapFromPrev = mergedYs[mergedYs.length - 1] - rowYs[i];
    const prev = merged[merged.length - 1];

    if (
      nonBlankCols.length === 1 &&
      gapFromPrev < typicalGap * 0.75 &&
      prev[nonBlankCols[0]] !== ''
    ) {
      const col = nonBlankCols[0];
      prev[col] = `${prev[col]} ${row[col]}`.trim();
      continue;
    }
    merged.push(row);
    mergedYs.push(rowYs[i]);
  }
  return merged;
}

/**
 * Reconstructs a 2D grid from a text-layer PDF buffer, suitable for the
 * same interpretation the Excel/CSV path uses (parseExcelGrid). Multi-page
 * PDFs are concatenated page-by-page (top to bottom, one grid).
 *
 * Returns an empty array when the PDF has no positioned text items at all
 * (a scanned/image-only PDF) — callers should treat that as "not this
 * shape" and route to the vision/LLM path instead.
 */
export async function extractPdfGrid(buffer: Buffer): Promise<string[][]> {
  const pages = await extractPositionedItems(buffer);
  const combined: string[][] = [];
  for (const pageItems of pages) {
    if (pageItems.length === 0) continue;
    const rows = clusterRows(pageItems);
    const anchors = deriveColumnAnchors(rows);
    const { grid, rowYs } = buildRawGrid(rows, anchors);
    const mergedGrid = mergeContinuationLines(grid, rowYs);
    combined.push(...mergedGrid);
  }
  return combined;
}

/** True when the PDF has a real, positioned text layer (not scanned/image-only). */
export async function hasPdfTextLayer(buffer: Buffer): Promise<boolean> {
  const pages = await extractPositionedItems(buffer);
  return pages.some((p) => p.length > 0);
}
