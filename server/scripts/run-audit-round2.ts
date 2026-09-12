import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseWorkbookBuffer, buildMergeExpandedGrid, TemplateDetectionError } from '../src/parsing/parseWorkbook.js';
import { parseExcelGrid, RosterExtractionAnomalyError } from '../src/parsing/deterministicGridParser.js';

const WEEK_START = '2026-08-24'; // Monday

function summarizeRows(rows: { employeeName: string; roleName: string; date: string; startTime: string; endTime: string }[]) {
  return rows.map((r) => `${r.employeeName} | role="${r.roleName}" | ${r.date} ${r.startTime}-${r.endTime}`).sort();
}

async function runXlsx(label: string, path: string) {
  console.log(`\n=== ${label} (${path}) ===`);
  const buf = readFileSync(path);
  try {
    const workbook = parseWorkbookBuffer(buf, path);
    console.log(`STAGE: long-format template parser ("${workbook.templateLabel}")`);
    console.log(`rows: ${workbook.rows.length}, issues: ${workbook.issues.length}`);
    console.log(summarizeRows(workbook.rows).join('\n'));
    if (workbook.issues.length) console.log('ISSUES:', JSON.stringify(workbook.issues, null, 2));
    return;
  } catch (err) {
    if (!(err instanceof TemplateDetectionError)) throw err;
  }
  const grid = buildMergeExpandedGrid(buf, path);
  console.log('GRID:', JSON.stringify(grid));
  try {
    const det = parseExcelGrid(grid, WEEK_START);
    console.log(`STAGE result: templateLabel="${det.templateLabel}"`);
    console.log(`rows: ${det.rows.length}, anomalies: ${det.anomalies.length}, issues: ${det.issues.length}, leaveRecords: ${det.leaveRecords.length}`);
    console.log(summarizeRows(det.rows).join('\n'));
    if (det.anomalies.length) console.log('ANOMALIES:', JSON.stringify(det.anomalies, null, 2));
    if (det.issues.length) console.log('ISSUES:', JSON.stringify(det.issues, null, 2));
    if (det.leaveRecords.length) console.log('LEAVE:', JSON.stringify(det.leaveRecords, null, 2));
    if (det.templateLabel !== 'Deterministic Grid Parser') {
      console.log('STAGE: deterministic grid parser did NOT recognize the shape -> real app would fall to Gemini grid-text fallback (parseRosterGrid) here.');
    }
  } catch (err) {
    if (err instanceof RosterExtractionAnomalyError) {
      console.log('STAGE: RosterExtractionAnomalyError thrown (loud failure, 422 in the real app):', err.message);
    } else {
      throw err;
    }
  }
}

async function main() {
  const dir = 'server/test-fixtures/edge-case-audit-round2';
  await runXlsx('1. Bilingual Arabic/English', `${dir}/1-bilingual-arabic.xlsx`);
  await runXlsx('2a. Merged header row', `${dir}/2a-merged-header-row.xlsx`);
  await runXlsx('2b. Merged staff rows', `${dir}/2b-merged-staff-rows.xlsx`);
  await runXlsx('3. Multi-sheet workbook', `${dir}/3-multi-sheet-workbook.xlsx`);
  await runXlsx('4. Split shifts', `${dir}/4-split-shifts.xlsx`);
  await runXlsx('5. Time-format inconsistency', `${dir}/5-time-format-inconsistency.xlsx`);
  await runXlsx('6. Footer/trailing noise', `${dir}/6-footer-trailing-noise.xlsx`);
  await runXlsx('7a. Missing day-of-week column', `${dir}/7a-missing-day-column.xlsx`);
  await runXlsx('7b. Extra unexplained column', `${dir}/7b-extra-column.xlsx`);
  await runXlsx('8. Nested sub-headers', `${dir}/8-nested-subheaders.xlsx`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
