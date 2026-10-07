import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoster, familyTruth, FAMILY_VARIANTS, subCells, shiftText, rng } from './families.js';
import { printedSheet, renderCsv, renderXlsx } from './familyRender.js';
import { perturbationsFor, transcriptionAnswer } from './mockVision.js';
import { scoreFamily } from './familyScore.js';
import { readLikeUploadRoute } from './familyPipeline.js';
import type { FamilyTruth } from './families.js';

const NOW = new Date('2026-10-07T09:00:00+04:00');
const spec = (id: string) => FAMILY_VARIANTS.find((v) => v.id === id)!;

/** A spreadsheet variant rendered in memory (no browser) with its truth. */
function spreadsheet(id: string): { data: Buffer; truth: FamilyTruth } {
  const roster = buildRoster(spec(id));
  const sheet = printedSheet(roster);
  const rows: { row: number; cells: string[] }[] = [];
  let n = 0;
  for (const r of sheet.rows) {
    n++;
    if (r.kind === 'person') rows.push({ row: n, cells: [] });
  }
  const data = spec(id).format === 'csv' ? renderCsv(sheet) : renderXlsx(sheet);
  return { data, truth: familyTruth(roster, `${id}.${spec(id).format}`, rows) };
}

test('the corpus: at least 15 variants per family, every one with made-up people and a printed week', () => {
  for (const family of ['A', 'B'] as const) {
    const variants = FAMILY_VARIANTS.filter((v) => v.family === family);
    assert.ok(variants.length >= 15, `${family}: ${variants.length}`);
    assert.ok(variants.some((v) => v.people >= 40 && v.pages === 2), `${family}: a 40+ person, 2-page roster`);
    assert.ok(new Set(variants.map((v) => v.format)).size >= 4, `${family}: several formats`);
  }
  assert.equal(new Set(FAMILY_VARIANTS.map((v) => v.id)).size, FAMILY_VARIANTS.length);
});

test('printed text is derived from the truth, never parsed back by the code under test', () => {
  assert.deepEqual(subCells('decimal', [[660, 1020], [1080, 1500]]), ['11', '17', '18', '25']);
  assert.deepEqual(subCells('decimal', [[1080, 1560]]), ['', '', '18', '26']);
  assert.deepEqual(subCells('colon-cells', [[570, 930]]), ['09:30', '15:30', '', '']);
  assert.equal(shiftText('colon24', [[1110, 1500]], rng(1)), '18:30-01:00');
  assert.equal(shiftText('dot24', [[600, 900], [1140, 1440]], rng(1)), '10.00-15.00/19.00-00.00');
  assert.match(shiftText('text12', [[960, 1560]], rng(1)), /^4pm to 2am$/);
});

test('mock AI reader: the first read drops a row, swaps a time, misreads a name and (multi-page) skips a page; a strict page re-read lists every row', () => {
  const { truth } = spreadsheet('A08-xlsx-merged');
  const p = perturbationsFor(truth);
  assert.ok(p.dropped && p.swapped && p.misread);
  const first = JSON.parse(transcriptionAnswer(truth, {}));
  const names = first.pages[0].sec.flatMap((s: { ppl: { nm: string }[] }) => s.ppl.map((x) => x.nm));
  assert.ok(!names.includes(p.dropped));
  assert.ok(names.includes(p.misread!.as) && !names.includes(p.misread!.name));
  assert.equal(first.pages[0].rows, truth.people.length, 'the model still counts the dropped row');
  const strict = JSON.parse(transcriptionAnswer(truth, { focus: { page: 1 }, strict: true }));
  assert.equal(strict.pages[0].sec.flatMap((s: { ppl: unknown[] }) => s.ppl).length, truth.people.length);
});

test('scoreFamily: recall, precision and silent drops', () => {
  const { truth } = spreadsheet('B05-csv');
  const perfect = scoreFamily(
    {
      rows: truth.shifts.map((s) => ({ employeeName: s.name, roleName: s.role, date: s.date, startTime: s.start, endTime: s.end })),
      leaveRecords: [],
      anomalies: [],
      people: truth.people.map((x) => ({ name: x.name })),
      unreadRows: [],
      weekStart: truth.week.weekStart,
    },
    truth,
  );
  assert.equal(perfect.staffRecall.ok, perfect.staffRecall.of);
  assert.equal(perfect.exactTime.ok, perfect.exactTime.of);
  assert.equal(perfect.silentPeople + perfect.silentShifts, 0);
  // A dropped person with nothing about them anywhere is a silent drop; an invented person costs precision.
  const victim = truth.people.find((x) => truth.shifts.some((s) => s.name === x.name))!;
  const lossy = scoreFamily(
    {
      rows: truth.shifts.filter((s) => s.name !== victim.name).map((s) => ({ employeeName: s.name, roleName: s.role, date: s.date, startTime: s.start, endTime: s.end })),
      leaveRecords: [],
      anomalies: [],
      people: [...truth.people.filter((x) => x.name !== victim.name).map((x) => ({ name: x.name })), { name: 'WAITERS' }],
      unreadRows: [],
      weekStart: truth.week.weekStart,
    },
    truth,
  );
  assert.equal(lossy.silentPeople, 1);
  assert.ok(lossy.silentShifts > 0);
  assert.equal(lossy.staffPrecision.ok, lossy.staffPrecision.of - 1);
  // The same person listed as an unread row is not silent.
  const flagged = scoreFamily({ rows: [], leaveRecords: [], anomalies: [], people: [], unreadRows: [{ text: victim.name }], weekStart: null }, truth);
  assert.equal(flagged.silentPeople, truth.people.length - 1);
});

test('spreadsheet variants read through the upload path: every person, every shift, the printed week (no client weekStart)', async () => {
  for (const id of ['A08-xlsx-merged', 'A09-csv', 'A15-second-week-xlsx', 'B04-xlsx-merged', 'B05-csv', 'B13-ordinal-xlsx-footer']) {
    const { data, truth } = spreadsheet(id);
    const run = await readLikeUploadRoute(data, truth, NOW);
    const s = scoreFamily(run.reading, truth);
    assert.equal(s.staffRecall.ok, s.staffRecall.of, `${id}: staff`);
    assert.equal(s.staffPrecision.ok, s.staffPrecision.of, `${id}: precision`);
    assert.equal(s.exactTime.ok, s.exactTime.of, `${id}: exact times`);
    assert.equal(s.week.ok, 1, `${id}: week`);
    assert.equal(s.silentPeople + s.silentShifts, 0, `${id}: silent drops`);
  }
});

test('round-2 variants: one per structural failure the holdout found, each with its mock failure', () => {
  const ids = FAMILY_VARIANTS.map((v) => v.id);
  for (const id of ['A19-totals-footer-pdf', 'A20-scan-coloured-shifts', 'A21-png-coloured-shifts', 'B19-name-first-headed', 'B20-ligatures-totals', 'B21-name-first-headed-xlsx', 'B22-png-last-row']) assert.ok(ids.includes(id), id);
  assert.ok(FAMILY_VARIANTS.find((v) => v.id === 'B20-ligatures-totals')!.ligatures);
  const { truth } = spreadsheet('B21-name-first-headed-xlsx');
  truth.printed.nameFirst = true;
  const p = perturbationsFor(truth);
  assert.equal(p.swapNameTitle, true);
  const first = JSON.parse(transcriptionAnswer(truth, {}));
  assert.ok(first.pages[0].sec.flatMap((s: { ppl: { nm: string }[] }) => s.ppl.map((x) => x.nm)).some((nm: string) => /\d|^[A-Z]{2,4}$/.test(nm)), 'titles read as names');
});
