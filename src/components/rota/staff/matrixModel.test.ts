import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrixCell, matrixGroups, matrixLegend } from './matrixModel';
import { typeCodes } from './weekModel';
import { demoWeek, leave, shift } from './testWeek';

test('matrix codes: type initial, both codes for a double, status words for leave, Off for nothing', () => {
  const w = demoWeek({
    shifts: [
      shift('a', '2026-10-05', 'm', [{ start: '07:00', end: '16:00' }]),
      shift('a', '2026-10-06', 'm', [{ start: '07:00', end: '11:00' }]),
      shift('a', '2026-10-06', 'e', [{ start: '16:00', end: '01:00' }]),
      shift('a', '2026-10-07', null, [{ start: '10:00', end: '14:00' }, { start: '18:00', end: '22:00' }]),
      shift('a', '2026-10-08', null, [{ start: '10:00', end: '14:00' }]),
    ],
    leaves: [leave('a', '2026-10-09', 'SICK_LEAVE'), leave('a', '2026-10-10', 'ANNUAL_LEAVE'), leave('a', '2026-10-11', 'DAY_OFF'), leave('b', '2026-10-05', 'UNPAID_LEAVE')],
  });
  const codes = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((d) => matrixCell(w, 'a', d).code);
  assert.deepEqual(codes, ['M', 'M+E', 'S', 'C', 'Sick', 'Leave', 'Off']);
  assert.equal(matrixCell(w, 'a', '2026-10-06').kind, 'double');
  assert.equal(matrixCell(w, 'a', '2026-10-06').detail, 'Morning 07:00–11:00 and Evening 16:00–01:00 +1');
  assert.equal(matrixCell(w, 'b', '2026-10-05').code, 'Unpaid');
  assert.equal(matrixCell(w, 'b', '2026-10-06').kind, 'off');
});

test('matrix groups follow the department order with a cell per day', () => {
  const groups = matrixGroups(demoWeek());
  assert.deepEqual(groups.map((g) => g.group.name), ['Floor', 'Bar', 'Other']);
  assert.equal(groups[0]!.rows[0]!.cells.length, 7);
});

test('legend lists the live types with their venue-unique codes', () => {
  const types = demoWeek().shiftTypes;
  const legend = matrixLegend([...types, { ...types[1]!, id: 'old', name: 'Old', archivedAt: '2026-01-01' }]);
  assert.deepEqual(legend.map((l) => `${l.code} ${l.name}`), ['M Morning', 'D Mid', 'E Evening', 'S Split']);
});

test('type codes stay unique: initial, then the next free consonant; archived types never take a live code', () => {
  const t = (id: string, name: string, sortOrder: number, archivedAt: string | null = null) => ({ id, name, sortOrder, archivedAt });
  const codes = typeCodes([t('old', 'Morning brunch', 0, '2026-01-01'), t('m', 'Morning', 1), t('d', 'Mid', 2), t('ml', 'Morning late', 3), t('e', 'Evening', 4)]);
  assert.equal(codes.get('m'), 'M');
  assert.equal(codes.get('d'), 'D');
  assert.equal(codes.get('ml'), 'R');
  assert.equal(codes.get('e'), 'E');
  assert.equal(codes.get('old'), 'N');
});
