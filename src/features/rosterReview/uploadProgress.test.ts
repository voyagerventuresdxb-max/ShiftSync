import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newUploadId, progressSteps, rosterFileKind } from './uploadProgress';
import type { UploadProgress } from '../../api/schedules';

const at = (p: Partial<UploadProgress>): UploadProgress => ({ stage: 'uploading', passed: [], pages: null, secondRead: null, ...p });
const show = (steps: ReturnType<typeof progressSteps>) => steps.map((s) => `${s.state}:${s.label}`);

test('before the server has seen the upload, a PDF shows every step it is expected to take', () => {
  assert.deepEqual(show(progressSteps(null, 'pdf')), [
    'current:Uploading',
    "upcoming:Reading the file's text",
    'upcoming:Reading the pages',
    'upcoming:Cross-checking the two readings',
    'upcoming:Matching people to your staff',
  ]);
});

test('a two-page text PDF: page N of M while the AI reads, then the cross-check and the matching', () => {
  const reading = at({ stage: 'reading_pages', passed: ['uploading', 'reading_text'], pages: { total: 2, done: 0, again: 0, againDone: 0 } });
  assert.deepEqual(show(progressSteps(reading, 'pdf')), [
    'done:Uploaded',
    "done:Read the file's text",
    'current:Reading page 1 of 2',
    'upcoming:Cross-checking the two readings',
    'upcoming:Matching people to your staff',
  ]);
  const second = at({ ...reading, pages: { total: 2, done: 1, again: 0, againDone: 0 } });
  assert.equal(progressSteps(second, 'pdf')[2]!.label, 'Reading page 2 of 2');
  const closer = at({ ...reading, pages: { total: 2, done: 2, again: 1, againDone: 0 } });
  assert.equal(progressSteps(closer, 'pdf')[2]!.label, 'Taking a second, closer look');
  const matching = at({ stage: 'matching', passed: ['uploading', 'reading_text', 'reading_pages', 'cross_checking'], pages: { total: 2, done: 2, again: 1, againDone: 1 } });
  assert.deepEqual(show(progressSteps(matching, 'pdf')), [
    'done:Uploaded',
    "done:Read the file's text",
    'done:Read all 2 pages',
    'done:Cross-checked the two readings',
    'current:Matching people to your staff',
  ]);
});

test('a scanned PDF never shows a text step it skipped', () => {
  const scan = at({ stage: 'reading_pages', passed: ['uploading'], pages: { total: 3, done: 0, again: 0, againDone: 0 } });
  assert.deepEqual(show(progressSteps(scan, 'pdf')), ['done:Uploaded', 'current:Reading page 1 of 3', 'upcoming:Cross-checking the two readings', 'upcoming:Matching people to your staff']);
});

test('a photo: the AI reading, then its second reading if that is still running, then the comparison', () => {
  const first = at({ stage: 'reading_pages', passed: ['uploading'], pages: { total: 1, done: 0, again: 0, againDone: 0 }, secondRead: 'running' });
  assert.equal(progressSteps(first, 'image')[1]!.label, 'Reading your roster with the AI reader');
  const second = at({ ...first, pages: { total: 1, done: 1, again: 0, againDone: 0 } });
  assert.equal(progressSteps(second, 'image')[1]!.label, 'Reading it a second time, column by column');
  assert.deepEqual(show(progressSteps(null, 'image')), ['current:Uploading', 'upcoming:Reading the photo', 'upcoming:Cross-checking the two readings', 'upcoming:Matching people to your staff']);
});

test('a spreadsheet the AI reader is asked to read gains that step when it starts', () => {
  assert.deepEqual(show(progressSteps(at({ stage: 'reading_text', passed: ['uploading'] }), 'sheet')), ['done:Uploaded', "current:Reading the file's text", 'upcoming:Matching people to your staff']);
  const ai = at({ stage: 'reading_pages', passed: ['uploading', 'reading_text'], pages: { total: 1, done: 0, again: 0, againDone: 0 } });
  assert.deepEqual(show(progressSteps(ai, 'sheet')), ['done:Uploaded', "done:Read the file's text", 'current:Reading your roster with the AI reader', 'upcoming:Matching people to your staff']);
});

test('file kinds, and upload ids are UUIDs', () => {
  assert.equal(rosterFileKind({ name: 'week.xlsx' }), 'sheet');
  assert.equal(rosterFileKind({ name: 'week.csv', type: 'text/csv' }), 'sheet');
  assert.equal(rosterFileKind({ name: 'rota.PDF' }), 'pdf');
  assert.equal(rosterFileKind({ name: 'IMG_0001', type: 'image/jpeg' }), 'image');
  const id = newUploadId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(newUploadId(), id);
});
