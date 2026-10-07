/**
 * Writes the layout-family corpus (families.ts) to a directory: `<id>.<ext>` plus
 * `<id>.truth.json`. Deterministic from the variant seeds. The rendered files are not committed
 * (PNGs and PDFs are large); `npm run eval:roster:generate` rebuilds them under
 * server/eval/roster/out/families (gitignored) in about a minute.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoster, familyTruth, FAMILY_VARIANTS, FILE_EXT, type FamilyTruth, type VariantSpec } from './families.js';
import { closeBrowser, imagePdf, printedSheet, renderCsv, renderPngPages, renderTextPdf, renderXlsx, type PrintedSheet } from './familyRender.js';

export const FAMILY_DIR = join('server', 'eval', 'roster', 'out', 'families');

/**
 * Every person's printed row (1-based, per page, headers included) and day cells as a careful
 * reader would transcribe them, in roster order.
 */
function personRows(sheet: PrintedSheet, repeatHeader: boolean, legend: { fill: string; label: string }[]): { row: number; cells: string[] }[] {
  const headerCount = sheet.rows.filter((r) => r.kind === 'title' || r.kind === 'header' || r.kind === 'subheader').length;
  const out: { row: number; cells: string[] }[] = [];
  const perPage = new Map<number, number>();
  for (const row of sheet.rows) {
    const n = (perPage.get(row.page) ?? (row.page > 1 && repeatHeader ? headerCount : 0)) + 1;
    perPage.set(row.page, n);
    if (row.kind !== 'person') continue;
    const days: string[] = [];
    if (sheet.columns === 29) {
      // Family A: four sub-cells per day after the name.
      for (let d = 0; d < 7; d++) {
        const sub = row.cells.slice(1 + d * 4, 5 + d * 4);
        const text = sub.map((c) => c.text).filter(Boolean).join(' ');
        const fill = sub.every((c) => !c.text) ? legend.find((l) => l.fill === sub[0]?.fill)?.label : undefined;
        days.push(text || (fill ? `[${fill}]` : ''));
      }
    } else {
      for (const c of row.cells.slice(2)) days.push(c.text || (c.fill === '#000000' ? '[?]' : ''));
    }
    out.push({ row: n, cells: days });
  }
  return out;
}

export async function renderVariant(spec: VariantSpec): Promise<{ file: string; data: Buffer; truth: FamilyTruth }> {
  const roster = buildRoster(spec);
  const sheet = printedSheet(roster);
  const file = `${spec.id}.${FILE_EXT[spec.format]}`;
  const opts = { shuffle: spec.shuffleText, repeatHeader: spec.repeatHeader, seed: spec.seed };
  let data: Buffer;
  switch (spec.format) {
    case 'xlsx':
      data = renderXlsx(sheet);
      break;
    case 'csv':
      data = renderCsv(sheet);
      break;
    case 'pdf-text':
      data = await renderTextPdf(sheet, opts);
      break;
    case 'png':
      data = (await renderPngPages(sheet, opts))[0]!;
      break;
    case 'pdf-image':
      data = await imagePdf(await renderPngPages(sheet, opts));
      break;
  }
  return { file, data, truth: familyTruth(roster, file, personRows(sheet, spec.repeatHeader, roster.legend)) };
}

export async function generateFamilies(dir = FAMILY_DIR, only?: (id: string) => boolean): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  try {
    for (const spec of FAMILY_VARIANTS) {
      if (only && !only(spec.id)) continue;
      const { file, data, truth } = await renderVariant(spec);
      writeFileSync(join(dir, file), data);
      writeFileSync(join(dir, `${spec.id}.truth.json`), `${JSON.stringify(truth, null, 2)}\n`);
      written.push(file);
    }
  } finally {
    await closeBrowser();
  }
  return written;
}

export function loadFamilies(dir = FAMILY_DIR): FamilyTruth[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.truth.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FamilyTruth);
}
