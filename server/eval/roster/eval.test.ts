import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS_DIR, generateCorpus } from './generate.js';
import { runEval } from './run.js';
import { score, totals } from './score.js';
import { CORPUS, truthOf, truthOfCell, type Truth } from './spec.js';

const truth: Truth = {
  id: 't',
  weekStart: '2026-08-17',
  shifts: [
    { name: 'Test Alpha', role: 'SUPERVISORS', date: '2026-08-17', start: '09:00', end: '17:00' },
    { name: 'Test Alpha', role: 'SUPERVISORS', date: '2026-08-18', start: '18:00', end: '01:00' },
  ],
  leave: [{ name: 'Test Beta', date: '2026-08-17', code: 'AL' }],
  flagged: [{ name: 'Test Beta', date: '2026-08-18' }],
};
const shift = (employeeName: string, date: string, startTime: string, endTime: string, roleName = 'Supervisor') =>
  ({ employeeName, date, startTime, endTime, roleName }) as never;

test('truthOfCell: the corpus vocabulary, independent of the parsers; unknown cells are an error', () => {
  assert.deepEqual(truthOfCell('9-17'), { shifts: [['09:00', '17:00']] });
  assert.deepEqual(truthOfCell('11 17 18 25'), { shifts: [['11:00', '17:00'], ['18:00', '01:00']] });
  assert.deepEqual(truthOfCell('10-14/18-23'), { shifts: [['10:00', '14:00'], ['18:00', '23:00']] });
  assert.deepEqual(truthOfCell('ul'), { leave: 'UL' });
  assert.deepEqual(truthOfCell('12CL'), { flagged: true });
  assert.equal(truthOfCell(''), null);
  assert.throws(() => truthOfCell('?'), /no defined meaning/);
});

test('score: a perfect parse is 100% on every field; role spelling and plural are normalised', () => {
  const s = score(
    {
      rows: [shift('Test Alpha', '2026-08-17', '09:00', '17:00'), shift('test  alpha', '2026-08-18', '18:00', '01:00', 'supervisors')],
      leaveRecords: [{ employeeName: 'Test Beta', date: '2026-08-17', leaveCode: 'al', category: 'leave' }],
      anomalies: [{ employeeName: 'Test Beta', date: '2026-08-18', rawText: '12CL', reason: '', confidence: 0.7, rowNumber: null }],
    },
    truth,
  );
  for (const k of ['name', 'day', 'start', 'end', 'role', 'leave', 'flagged'] as const) assert.equal(s[k].ok, s[k].of, k);
  assert.equal(s.extraShifts, 0);
});

test('score: a missing shift, a wrong end and an invented shift each count against the parse', () => {
  const s = score(
    { rows: [shift('Test Alpha', '2026-08-17', '09:00', '18:00'), shift('Test Gamma', '2026-08-19', '10:00', '14:00')], leaveRecords: [], anomalies: [] },
    truth,
  );
  assert.deepEqual([s.day.ok, s.start.ok, s.end.ok, s.leave.ok, s.flagged.ok, s.extraShifts], [1, 1, 0, 0, 0, 1]);
  assert.deepEqual(score(null, truth).day, { ok: 0, of: 2 });
  assert.deepEqual(totals([s, s]).day, { ok: 2, of: 4 });
});

test('the committed corpus matches what the spec generates (re-run npm run eval:roster:generate after changing spec.ts)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-eval-'));
  try {
    await generateCorpus(dir);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.truth.json'))) {
      assert.deepEqual(JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')), JSON.parse(readFileSync(join(dir, f), 'utf8')), f);
    }
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.truth.json')).length, CORPUS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline eval: every roster scored, clean layouts stay at 100%, the escalation rules agree with expectations, no names in the report', async () => {
  const report = await runEval({ vision: 'none', visionAll: false, record: false, priceIn: null, priceOut: null });
  assert.equal(report.deterministic.length, CORPUS.length);
  for (const id of ['grid-western', 'csv-grid', 'title-column-filipino', 'long-format-indian', 'am-pm-merged', 'leave-codes', 'pdf-text-grid', 'multi-sheet']) {
    const d = report.deterministic.find((r) => r.id === id)!;
    assert.equal(d.score.day.ok, d.score.day.of, `${id}: every shift found`);
    assert.equal(d.score.end.ok, d.score.end.of, `${id}: every end time right`);
    assert.equal(d.score.extraShifts, 0, `${id}: nothing invented`);
  }
  for (const id of ['grid-arabic-caps', 'no-section-headers', 'multi-sheet-notes-first']) {
    const d = report.deterministic.find((r) => r.id === id)!;
    assert.equal(d.escalation, d.expected, id);
  }
  const names = CORPUS.flatMap((c) => truthOf(c).shifts.map((s) => s.name.split(' ')[0]!.toLowerCase()));
  assert.ok(!names.some((n) => report.markdown.toLowerCase().includes(n)), 'the report must not contain staff names');
});

test('vision mock mode runs only the escalated rosters through the provider seam and scores them', async () => {
  const report = await runEval({ vision: 'mock', visionAll: false, record: false, priceIn: null, priceOut: null });
  const escalated = report.deterministic.filter((d) => d.escalation).map((d) => d.id).sort();
  assert.deepEqual(report.vision.map((v) => v.id).sort(), escalated);
  assert.ok(report.vision.every((v) => v.score && v.score.day.ok === v.score.day.of));
  assert.match(report.markdown, /pipeline check only/);
});

test('live mode refuses without a configured provider (it never fakes a model)', async () => {
  const saved = { p: process.env.GEMINI_VERTEX_PROJECT, k: process.env.GEMINI_API_KEY };
  delete process.env.GEMINI_VERTEX_PROJECT;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(runEval({ vision: 'live', visionAll: false, record: false, priceIn: null, priceOut: null }), /needs a configured vision provider/);
  } finally {
    if (saved.p !== undefined) process.env.GEMINI_VERTEX_PROJECT = saved.p;
    if (saved.k !== undefined) process.env.GEMINI_API_KEY = saved.k;
  }
});
