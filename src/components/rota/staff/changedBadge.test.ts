import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedDates, daySignatures, loadSeen, saveSeen, seenKey } from './changedBadge';
import { demoWeek, leave, shift } from './testWeek';

const evening = [{ start: '16:00', end: '01:00' }];

test('first view: nothing is marked changed', () => {
  const w = demoWeek({ shifts: [shift('a', '2026-10-10', 'e', evening)] });
  assert.equal(changedDates(null, daySignatures(w, 'a')).size, 0);
});

test('a moved, re-timed, re-typed, added or removed shift marks its day; other people do not', () => {
  const sat = shift('a', '2026-10-10', 'e', evening);
  const mon = shift('a', '2026-10-05', 'd', [{ start: '11:00', end: '20:00' }]);
  const before = daySignatures(demoWeek({ shifts: [sat, mon] }), 'a');
  const seen = { publishedVersion: 3, days: before };

  // Saturday re-timed, Monday removed, Wednesday added, someone else changed.
  const after = demoWeek({
    shifts: [
      { ...sat, ranges: [{ start: '17:00', end: '01:00' }] },
      shift('a', '2026-10-07', 'm', [{ start: '07:00', end: '16:00' }]),
      shift('b', '2026-10-06', 'm', [{ start: '07:00', end: '16:00' }]),
    ],
  });
  assert.deepEqual([...changedDates(seen, daySignatures(after, 'a'))].sort(), ['2026-10-05', '2026-10-07', '2026-10-10']);

  // Same shifts again: nothing changed (cleared after viewing).
  assert.equal(changedDates({ publishedVersion: 4, days: daySignatures(after, 'a') }, daySignatures(after, 'a')).size, 0);
});

test('a type change with the same times still counts; leave counts too', () => {
  const s = shift('a', '2026-10-06', 'm', [{ start: '07:00', end: '16:00' }]);
  const seen = { publishedVersion: 1, days: daySignatures(demoWeek({ shifts: [s] }), 'a') };
  const retyped = daySignatures(demoWeek({ shifts: [{ ...s, shiftTypeId: 'x' }], leaves: [leave('a', '2026-10-08', 'ANNUAL_LEAVE')] }), 'a');
  assert.deepEqual([...changedDates(seen, retyped)].sort(), ['2026-10-06', '2026-10-08']);
});

test('storage failures are tolerated', () => {
  // Replace whatever storage this runtime has (Node may define its own) and put it back after.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const install = (value: unknown) => Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
  try {
    // Storage that throws on every access.
    install({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    assert.equal(loadSeen(seenKey('u', 'v', '2026-10-05')), null);
    saveSeen('k', { publishedVersion: null, days: {} });
    // A working in-memory storage round-trips.
    const mem = new Map<string, string>();
    install({ getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
    saveSeen('k', { publishedVersion: 2, days: { '2026-10-05': 'x' } });
    assert.deepEqual(loadSeen('k'), { publishedVersion: 2, days: { '2026-10-05': 'x' } });
    mem.set('bad', '{nope');
    assert.equal(loadSeen('bad'), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
