import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Server date logic must not depend on the process timezone: Railway runs
 * UTC, a developer laptop runs Asia/Dubai, and a mis-set `TZ` must never move
 * a shift. This test runs `timezoneMatrix.probe.ts` once per zone in a child
 * process (Node reads `TZ` at startup, so it cannot be flipped in-process)
 * and asserts that every probe produces the same, expected values.
 */
const ZONES = ['UTC', 'Asia/Dubai', 'America/Los_Angeles'];
const here = dirname(fileURLToPath(import.meta.url));

function runProbe(tz: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(here, 'timezoneMatrix.probe.ts')], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `probe failed under TZ=${tz}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

test('server date logic is identical under TZ=UTC, Asia/Dubai and America/Los_Angeles, and matches the venue calendar', () => {
  const expected = {
    // 2026-10-03 10:00 Dubai (Saturday) → week of Mon 28 Sep; venue date Oct 3.
    weekStart_oct3_dubai: '2026-09-28',
    today_oct3_dubai: '2026-10-03',
    // 2026-10-31 23:30 Dubai (Saturday) → week of Mon 26 Oct; still Oct 31 in Dubai though 19:30Z.
    weekStart_oct31_dubai: '2026-10-26',
    today_oct31_dubai: '2026-10-31',
    // 2026-12-31 23:30 Dubai (Thursday) → week of Mon 28 Dec 2026; the venue is still in 2026.
    weekStart_dec31_dubai: '2026-12-28',
    today_dec31_dubai: '2026-12-31',
    // 00:30 Monday Dubai = 20:30 Sunday UTC: the venue is already in the new week.
    weekStart_monday_0030_dubai: '2026-10-05',
    today_monday_0030_dubai: '2026-10-05',
    // The same instant seen from a Los Angeles venue is still Sunday Oct 4 → week of Sep 28.
    weekStart_monday_0030_dubai_as_la_venue: '2026-09-28',
    // Wednesday 2026-10-07 16:59 Dubai: the window closes today at 17:00 Dubai (13:00Z).
    close_wed_1659: '2026-10-07T13:00:00.000Z',
    // Wednesday 2026-10-07 17:01 Dubai: already past, so next Wednesday.
    close_wed_1701: '2026-10-14T13:00:00.000Z',
    // Exactly 17:00:00 Dubai counts as closed → next week.
    close_wed_1700: '2026-10-14T13:00:00.000Z',
    // A Los Angeles venue closes Wednesday 17:00 LA (PDT, 00:00Z Thursday).
    close_wed_la_venue: '2026-10-08T00:00:00.000Z',
    // A 09:00–17:00 Dubai shift labels as 09:00–17:00, never 05:00 (UTC) or the host's zone.
    label_dubai_shift: 'Mon 5 Oct · 09:00–17:00',
    // Week range as instants in the venue's zone: Monday 00:00 Dubai = Sunday 20:00Z.
    week_range_dubai_start: '2026-10-04T20:00:00.000Z',
    week_range_dubai_end: '2026-10-11T20:00:00.000Z',
    monday_check: [true, false, false, true],
  };
  const results = ZONES.map((tz) => [tz, runProbe(tz)] as const);
  for (const [tz, actual] of results) {
    assert.deepEqual(actual, expected, `TZ=${tz}`);
  }
});
