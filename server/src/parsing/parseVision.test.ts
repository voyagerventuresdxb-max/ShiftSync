import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapVlmResponseToResult } from './parseVision.js';
import { SAMPLE_VLM_RESPONSE } from './__fixtures__/sampleVlmResponse.fixture.js';

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

test('the fixture VLM response maps to a valid result (no Gemini call)', () => {
  const result = mapVlmResponseToResult(SAMPLE_VLM_RESPONSE, '2026-08-17');
  assert.ok(result.rows.length > 0, 'fixture yields shifts');
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
  assert.ok(managers.length >= 3, 'management staff present in fixture');

  // AM/PM split shifts are preserved with their period labels.
  const andrea = result.rows.filter((r) => r.employeeName === 'Andrea');
  assert.equal(andrea.length, 2, 'Andrea has AM+PM split');
  assert.ok(andrea.some((r) => r.managerNotes?.includes('[AM]')));
  assert.ok(andrea.some((r) => r.managerNotes?.includes('[PM]')));

  // Leave records (day off) are captured.
  assert.ok(result.leaveRecords.some((l) => l.employeeName === 'Tomas' && l.category === 'day_off'));
});

// --- Legend-code shift resolution -----------------------------------------
//
// Per vlmPrompt.ts's own design, legend-code resolution (detecting an
// in-file legend like "A = 07:00-15:00" and resolving a coded cell's
// startTime/endTime using it) happens ENTIRELY inside the model's own single
// JSON response — the model is instructed to read the legend and emit the
// already-resolved startTime/endTime directly on the cell. There was
// previously no test coverage proving `mapVlmResponseToResult` (the only
// server-side code touching this data) correctly surfaces the returned
// legend as metadata and correctly carries through cells whose times were
// already resolved this way, without re-deriving or discarding them. These
// tests fix that gap by mocking exactly that response shape — no real model
// call, following this file's existing fixture-JSON pattern.

test('legend metadata is surfaced unchanged (code + meaning), category dropped', () => {
  const parsed = {
    venueTemplateNotes: 'Legend-code shift system: A/M/E backed by an in-file key',
    legend: [
      { code: 'A', meaning: '07:00-15:00', category: 'shift' },
      { code: 'M', meaning: '15:00-23:00', category: 'shift' },
      { code: 'OFF', meaning: 'Day Off', category: 'day_off' },
    ],
    employees: [],
    documentAnomalies: [],
  };

  const result = mapVlmResponseToResult(parsed as never, '2026-08-17');
  assert.deepEqual(result.legend, [
    { code: 'A', meaning: '07:00-15:00' },
    { code: 'M', meaning: '15:00-23:00' },
    { code: 'OFF', meaning: 'Day Off' },
  ]);
});

test('a legend-coded cell already resolved by the model (per vlmPrompt) carries through its exact startTime/endTime, not re-derived from rawText', () => {
  const parsed = {
    venueTemplateNotes: 'Legend-code shift system',
    legend: [{ code: 'A', meaning: '07:00-15:00', category: 'shift' }],
    employees: [
      {
        rawName: 'Ahmed Ali',
        role: 'Waiter',
        cells: [
          {
            // rawText is just the bare code as printed on the sheet — the
            // model itself already resolved it against the legend and
            // returned the real times, not "A" as a literal time string.
            date: '2026-08-17',
            rawText: 'A',
            period: null,
            interpretation: 'worked_shift',
            startTime: '07:00',
            endTime: '15:00',
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
  assert.equal(result.anomalies.length, 0, 'a legend-resolved cell is not an anomaly');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].employeeName, 'Ahmed Ali');
  assert.equal(result.rows[0].startTime, '07:00');
  assert.equal(result.rows[0].endTime, '15:00');
  assert.equal(result.rows[0].overnight, false);
});

test('multiple employees using different legend-resolved codes on the same day resolve independently, no cross-contamination', () => {
  const parsed = {
    venueTemplateNotes: 'Legend-code shift system: M/E/N backed by an in-file key',
    legend: [
      { code: 'M', meaning: 'Morning (07:00-15:00)', category: 'shift' },
      { code: 'E', meaning: 'Evening (15:00-23:00)', category: 'shift' },
      { code: 'N', meaning: 'Night (23:00-07:00)', category: 'shift' },
    ],
    employees: [
      {
        rawName: 'Ahmed Ali',
        role: 'Waiter',
        cells: [
          { date: '2026-08-17', rawText: 'M', period: null, interpretation: 'worked_shift', startTime: '07:00', endTime: '15:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
        ],
      },
      {
        rawName: 'Noor Said',
        role: 'Captain',
        cells: [
          { date: '2026-08-17', rawText: 'N', period: null, interpretation: 'worked_shift', startTime: '23:00', endTime: '07:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
        ],
      },
    ],
    documentAnomalies: [],
  };

  const result = mapVlmResponseToResult(parsed as never, '2026-08-17');
  assert.equal(result.rows.length, 2);

  const ahmed = result.rows.find((r) => r.employeeName === 'Ahmed Ali');
  assert.equal(ahmed!.startTime, '07:00');
  assert.equal(ahmed!.endTime, '15:00');
  assert.equal(ahmed!.overnight, false);

  const noor = result.rows.find((r) => r.employeeName === 'Noor Said');
  assert.equal(noor!.startTime, '23:00');
  assert.equal(noor!.endTime, '07:00');
  assert.equal(noor!.overnight, true, 'Night legend code correctly resolves to an overnight shift');
});

test('a legend-coded cell resolved by the model as a leave/absence type (not a worked shift) still produces a leave record, not a shift row', () => {
  // A file's legend can define a code that means an absence rather than a
  // worked shift (e.g. "OFF" = Day Off) — the model resolves the
  // INTERPRETATION too, not just times, so this must route to
  // leaveRecords like any other leave cell, never a shift row with fake
  // startTime/endTime.
  const parsed = {
    venueTemplateNotes: 'Legend-code shift system',
    legend: [{ code: 'OFF', meaning: 'Day Off', category: 'day_off' }],
    employees: [
      {
        rawName: 'Reem Fakhoury',
        role: 'Runner',
        cells: [
          { date: '2026-08-17', rawText: 'OFF', period: null, interpretation: 'day_off', startTime: null, endTime: null, leaveCode: 'OFF', confidence: 0.9, needsReview: false, reviewReason: null },
        ],
      },
    ],
    documentAnomalies: [],
  };

  const result = mapVlmResponseToResult(parsed as never, '2026-08-17');
  assert.equal(result.rows.length, 0);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.leaveRecords.length, 1);
  assert.equal(result.leaveRecords[0].employeeName, 'Reem Fakhoury');
  assert.equal(result.leaveRecords[0].category, 'day_off');
  assert.equal(result.leaveRecords[0].leaveCode, 'OFF');
});
