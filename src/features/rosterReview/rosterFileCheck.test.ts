import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROSTER_ACCEPT, ROSTER_MAX_BYTES, rosterFileProblem } from './rosterFileCheck';

const file = (name: string, size = 2048, type = '') => ({ name, size, type });

test('every kind of roster the server reads passes: PDF, photo, Excel, CSV (by type or by extension)', () => {
  for (const f of [
    file('week.pdf', 2048, 'application/pdf'),
    file('IMG_0042.JPG', 2048, 'image/jpeg'),
    file('scan.png'),
    file('scan.webp'),
    file('rota.xlsx'),
    file('rota.xls'),
    file('rota.csv', 2048, 'text/csv'),
    file('export', 2048, 'application/csv'),
    file('roster-photo', 2048, 'image/png'),
  ]) {
    assert.equal(rosterFileProblem(f), null, f.name);
  }
});

test('a file the server would refuse is turned away before anything is sent, in plain words', () => {
  assert.match(rosterFileProblem(file('notes.docx'))!, /can't read "notes\.docx"\. Choose a PDF, a photo \(JPG, PNG or WebP\), an Excel file or a CSV\./);
  assert.match(rosterFileProblem(file('IMG_0042.HEIC', 2048, 'image/heic'))!, /can't read/);
});

test('an empty file and a file over 10 MB each get their own message', () => {
  assert.equal(rosterFileProblem(file('rota.csv', 0)), '"rota.csv" is empty. Choose the roster file again.');
  assert.equal(rosterFileProblem(file('big.pdf', ROSTER_MAX_BYTES)), null);
  assert.match(rosterFileProblem(file('big.pdf', ROSTER_MAX_BYTES + 1))!, /"big\.pdf" is 10\.0 MB; the limit is 10 MB\./);
  assert.match(rosterFileProblem(file('huge.png', 12.4 * 1024 * 1024))!, /is 12\.4 MB/);
});

test('the picker offers photos, files and spreadsheets, and never forces the camera', () => {
  for (const token of ['.pdf', '.jpg', '.png', '.webp', '.xlsx', '.xls', '.csv', 'image/jpeg', 'application/pdf']) {
    assert.ok(ROSTER_ACCEPT.split(',').includes(token), token);
  }
  assert.ok(!/capture/.test(ROSTER_ACCEPT));
});
