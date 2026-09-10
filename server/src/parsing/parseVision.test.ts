import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_SAMPLE_RESPONSE, mapVlmResponseToResult } from './parseVision.js';

test('preserves AM/PM period labels on split shifts', () => {
  const parsed = {
    venueTemplateNotes: 'AM/PM sub-columns per day',
    legend: [],
    employees: [
      {
        rawName: 'Andrea',
        role: 'Floor',
        cells: [
          {
            date: '2026-08-18',
            rawText: '11-17',
            period: 'AM',
            interpretation: 'worked_shift',
            startTime: '11:00',
            endTime: '17:00',
            leaveCode: null,
            confidence: 0.9,
            needsReview: false,
            reviewReason: null,
          },
          {
            date: '2026-08-18',
            rawText: '18-01',
            period: 'PM',
            interpretation: 'worked_shift',
            startTime: '18:00',
            endTime: '01:00',
            leaveCode: null,
            confidence: 0.9,
            needsReview: false,
            reviewReason: null,
          },
        ],
      },
    ],
    documentAnomalies: [],
  };

  const result = mapVlmResponseToResult(parsed as never, '2026-08-17');
  assert.equal(result.rows.length, 2, 'both AM and PM shifts emitted');
  assert.equal(result.anomalies.length, 0, 'no anomalies for a clean split');

  const am = result.rows.find((r) => r.managerNotes?.includes('[AM]'));
  const pm = result.rows.find((r) => r.managerNotes?.includes('[PM]'));
  assert.ok(am, 'AM shift present with [AM] label');
  assert.ok(pm, 'PM shift present with [PM] label');
  assert.equal(am!.startTime, '11:00');
  assert.equal(am!.endTime, '17:00');
  assert.equal(pm!.startTime, '18:00');
  assert.equal(pm!.endTime, '01:00');
  assert.equal(pm!.overnight, true, 'PM overnight shift flagged');
});

test('emits a single shift when no AM/PM sub-columns (period null)', () => {
  const parsed = {
    venueTemplateNotes: 'single column per day',
    legend: [],
    employees: [
      {
        rawName: 'Maria',
        role: 'Waiter',
        cells: [
          {
            date: '2026-08-18',
            rawText: '10-18',
            period: null,
            interpretation: 'worked_shift',
            startTime: '10:00',
            endTime: '18:00',
            leaveCode: null,
            confidence: 0.9,
            needsReview: false,
            reviewReason: null,
          },
        ],
      },
    ],
    documentAnomalies: [],
  };

  const result = mapVlmResponseToResult(parsed as never, '2026-08-17');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].managerNotes, null, 'no period label when single column');
});

test('fallback sample response maps to a valid result (no Gemini call)', () => {
  const result = mapVlmResponseToResult(FALLBACK_SAMPLE_RESPONSE, '2026-08-17');
  assert.ok(result.rows.length > 0, 'fallback sample yields shifts');
  assert.ok(result.anomalies.length === 0, 'clean sample has no anomalies');

  // No employee has more than 2 shifts on a single day (AM+PM split max).
  const perEmpDay = new Map<string, number>();
  for (const r of result.rows) {
    const key = `${r.employeeName}|${r.date}`;
    perEmpDay.set(key, (perEmpDay.get(key) ?? 0) + 1);
  }
  for (const [key, count] of perEmpDay) {
    assert.ok(count <= 2, `no more than 2 shifts per employee per day (${key}: ${count})`);
  }

  // Management rows are present and carry their management titles.
  const managers = result.rows.filter((r) => r.roleName === 'Manager');
  assert.ok(managers.length >= 3, 'management staff present in fallback sample');

  // AM/PM split shifts are preserved with their period labels.
  const andrea = result.rows.filter((r) => r.employeeName === 'Andrea');
  assert.equal(andrea.length, 2, 'Andrea has AM+PM split');
  assert.ok(andrea.some((r) => r.managerNotes?.includes('[AM]')));
  assert.ok(andrea.some((r) => r.managerNotes?.includes('[PM]')));

  // Leave records (day off) are captured.
  assert.ok(result.leaveRecords.some((l) => l.employeeName === 'Tomas' && l.category === 'day_off'));
});
