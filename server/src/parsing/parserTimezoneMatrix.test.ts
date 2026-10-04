import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Roster parsing must give the same answer on a UTC Railway host, an
 * Asia/Dubai laptop and a Los Angeles laptop. `parserTimezoneMatrix.probe.ts`
 * parses the whole committed spreadsheet corpus plus synthetic CSV / HTML /
 * typed-cell inputs through every entry point the upload route uses, once per
 * zone in a child process (Node reads `TZ` at startup). The three documents
 * must be identical, and the synthetic cases must come out as the sheet says.
 */
const ZONES = ['UTC', 'Asia/Dubai', 'America/Los_Angeles'];
const here = dirname(fileURLToPath(import.meta.url));

type Row = { employeeName: string; date: string; startTime: string; endTime: string; overnight?: boolean };
type Probe = Record<string, { template: { rows?: Row[]; issues?: unknown[]; error?: string }; deterministicGrid: { rows?: Row[]; anomalies?: unknown[]; error?: string }; gridText?: string }>;

function runProbe(tz: string): Probe {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(here, 'parserTimezoneMatrix.probe.ts')], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `probe failed under TZ=${tz}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as Probe & { tz: string };
  delete (parsed as { tz?: string }).tz;
  return parsed;
}

const key = (r: Row) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}${r.overnight ? '|overnight' : ''}`;

test('the whole parser corpus parses identically under TZ=UTC, Asia/Dubai and America/Los_Angeles', () => {
  const [utc, dubai, la] = ZONES.map(runProbe);
  const inputs = Object.keys(utc!);
  assert.ok(inputs.length >= 21 + 4, `corpus + synthetic inputs probed: ${inputs.length}`);
  for (const input of inputs) {
    assert.deepEqual(dubai![input], utc![input], `Asia/Dubai differs from UTC for ${input}`);
    assert.deepEqual(la![input], utc![input], `America/Los_Angeles differs from UTC for ${input}`);
  }
});

test('typed Excel date/time cells read as the sheet shows them (never shifted by the host offset)', () => {
  const probe = runProbe('Asia/Dubai');
  const rows = probe['synthetic/typed-cells.xlsx']!.template.rows!.map(key).sort();
  assert.deepEqual(rows, [
    'Ali Hassan|2026-08-20|09:00-17:00',
    'Mona Said|2026-08-20|18:00-01:00|overnight',
    'Omar Farouk|2026-08-21|12:00-22:00',
  ]);
  assert.deepEqual(probe['synthetic/typed-cells.xlsx']!.template.issues, []);
});

test('CSV and HTML text dates and times: month names, AM/PM, seconds, "9 AM" (the earlier xlsx-upgrade regressions)', () => {
  const probe = runProbe('America/Los_Angeles');
  const csv = probe['synthetic/long-format-month-names.csv']!.template;
  assert.deepEqual(csv.rows!.map(key).sort(), [
    'Ali Hassan|2026-08-20|09:00-17:00',
    'Mona Said|2026-08-20|18:00-01:00|overnight',
    'Omar Farouk|2026-08-21|09:00-17:00',
    'Rami Toma|2026-08-22|13:00-21:00',
    'Sara Nour|2026-08-22|09:00-17:00',
    'Tala Adel|2026-08-23|21:00-23:30',
  ]);
  assert.deepEqual(csv.issues, []);
  const html = probe['synthetic/long-format.html.xls']!.template;
  assert.deepEqual(html.rows!.map(key).sort(), ['Ali Hassan|2026-08-20|09:00-17:00', 'Mona Said|2026-08-21|21:00-01:00|overnight']);
  assert.deepEqual(html.issues, []);
});

test('day headers with a weekday ("Mon 17/08", "MON 18-08", "Wed 19 Aug", "20/08 Thu") read as DD/MM in every zone; a wrong weekday is flagged', () => {
  // The first test proves every zone gives the same document; Los Angeles is the zone furthest behind UTC.
  const grid = runProbe('America/Los_Angeles')['synthetic/grid-weekday-date-headers.csv']!.deterministicGrid;
  assert.equal(grid.error, undefined, grid.error ?? '');
  assert.deepEqual(grid.rows!.map(key).sort(), [
    'Ali Hassan|2026-08-17|09:00-17:00',
    'Ali Hassan|2026-08-18|09:00-17:00',
    'Ali Hassan|2026-08-20|10:00-18:00',
    'Ali Hassan|2026-08-21|10:00-18:00',
    'Mona Said|2026-08-17|14:00-22:00',
    'Mona Said|2026-08-19|14:00-22:00',
    'Mona Said|2026-08-20|14:00-22:00',
  ]);
  const flagged = (grid.anomalies as { employeeName: string; date: string; reason: string }[]).filter((a) => /day header says/.test(a.reason));
  assert.deepEqual(flagged.map((a) => `${a.employeeName}|${a.date}`), ['Ali Hassan|2026-08-21']);
  assert.match(flagged[0]!.reason, /says Saturday, but 2026-08-21 is a Friday/);
});

test('a grid CSV of hour ranges ("10-18") is a roster, not a row of 2001 dates', () => {
  const probe = runProbe('UTC');
  const grid = probe['synthetic/grid-hour-ranges.csv']!.deterministicGrid;
  assert.equal(grid.error, undefined, grid.error ?? '');
  const rows = grid.rows!.map(key).sort();
  assert.ok(rows.includes('Ali Hassan|2026-08-17|10:00-18:00'), rows.join('\n'));
  assert.ok(rows.includes('Ali Hassan|2026-08-21|01:00-09:00'), rows.join('\n'));
  assert.ok(rows.includes('Mona Said|2026-08-23|10:00-18:00'), rows.join('\n'));
  assert.equal(rows.length, 8, rows.join('\n'));
});
