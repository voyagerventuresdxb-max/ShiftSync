import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnHeading, isFooterTotalOrNote, nonPersonReason } from './personKey.js';

test('nonPersonReason: titles, headings, totals, footers, captions and counts are never people', () => {
  for (const label of ['Waiter 3', 'Head waiter 1', 'RM', 'JAM', 'Supervisor', 'Ops Manager', 'Events Manager', 'Runner 2nd', 'NAME', 'TITLE', 'Staff', 'Day of the week', 'Total staff on rota', 'Total staff on rota: 22', 'Headcount', 'Number of staff', 'Prepared by: Duty Manager', 'Printed 2026-08-17', 'Page 1 of 2', 'Signature ________', 'COVERS', 'Notes', '22']) {
    assert.ok(nonPersonReason(label), label);
  }
  for (const name of ['Test Alpha', 'Saffiya Okonkwo', 'KIKI', 'Jojo', "Rodel D'Cruz", 'Ana-Maria Popescu', 'Nguyễn Thị Lan']) {
    assert.equal(nonPersonReason(name), null, name);
  }
  assert.match(nonPersonReason('Waiter 3')!, /title/);
  assert.match(nonPersonReason('Total staff on rota')!, /total/);
});

test('isFooterTotalOrNote and columnHeading', () => {
  assert.equal(isFooterTotalOrNote('Total staff on rota 20'), true);
  assert.equal(isFooterTotalOrNote('Test Alpha'), false);
  assert.equal(columnHeading('NAME'), 'name');
  assert.equal(columnHeading('Employee name'), 'name');
  assert.equal(columnHeading('TITLE'), 'title');
  assert.equal(columnHeading('Position'), 'title');
  assert.equal(columnHeading('DATE'), null);
});
