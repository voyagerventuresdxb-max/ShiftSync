import { readFileSync } from 'node:fs';
import { parseWorkbookBuffer, buildMergeExpandedGrid, TemplateDetectionError } from '../src/parsing/parseWorkbook.js';
import { parseExcelGrid } from '../src/parsing/deterministicGridParser.js';

const WEEK_START = '2026-08-24';

function summarizeRows(rows: { employeeName: string; roleName: string; date: string; startTime: string; endTime: string }[]) {
  return rows.map((r) => `${r.employeeName} | role="${r.roleName}" | ${r.date} ${r.startTime}-${r.endTime}`).sort();
}

async function runXlsx(label: string, path: string) {
  console.log(`\n=== ${label} (${path}) ===`);
  const buf = readFileSync(path);
  try {
    const workbook = parseWorkbookBuffer(buf, path);
    console.log(`STAGE: long-format template parser ("${workbook.templateLabel}")`);
    console.log(summarizeRows(workbook.rows).join('\n'));
    return;
  } catch (err) {
    if (!(err instanceof TemplateDetectionError)) throw err;
  }
  const grid = buildMergeExpandedGrid(buf, path);
  console.log('GRID:', JSON.stringify(grid));
  const det = parseExcelGrid(grid, WEEK_START);
  console.log(`STAGE result: templateLabel="${det.templateLabel}"`);
  console.log(`rows: ${det.rows.length}, anomalies: ${det.anomalies.length}, issues: ${det.issues.length}`);
  console.log(summarizeRows(det.rows).join('\n'));
  if (det.anomalies.length) console.log('ANOMALIES:', JSON.stringify(det.anomalies, null, 2));
  if (det.issues.length) console.log('ISSUES:', JSON.stringify(det.issues, null, 2));
}

async function main() {
  const dir = 'server/test-fixtures/edge-case-audit';
  await runXlsx('1. ALL-CAPS-only roster', `${dir}/1-all-caps-roster.xlsx`);
  await runXlsx('2. Novel section-header vocabulary', `${dir}/2-novel-header-vocab.xlsx`);
  await runXlsx('3. No unlabeled staff rows above first header', `${dir}/3-no-anchor-first-header.xlsx`);
  await runXlsx('5. Combined: ALL-CAPS + novel headers', `${dir}/5-combined-worst-case.xlsx`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
