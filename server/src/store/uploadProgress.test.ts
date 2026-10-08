import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UPLOAD_PROGRESS_FINISHED_TTL_MS, UPLOAD_PROGRESS_TTL_MS, UploadProgressStore, type UploadProgressView } from './uploadProgress.js';

const venueA = { locationId: 'venue-a', sessionKey: 'session-a' };

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('a text PDF read by the AI reader: stages are recorded in the order they ran, with page counts', () => {
  const store = new UploadProgressStore();
  const id = randomUUID();
  assert.equal(store.start(id, venueA), true);
  const view = () => {
    const r = store.read(id, venueA);
    assert.equal(r.status, 'ok');
    return (r as { view: UploadProgressView }).view;
  };
  assert.deepEqual(view(), { stage: 'uploading', passed: [], pages: null, secondRead: null });

  store.report(id, { kind: 'text' });
  store.report(id, { kind: 'page', page: 1, of: 2, state: 'started' });
  store.report(id, { kind: 'page', page: 2, of: 2, state: 'started' });
  assert.deepEqual(view(), { stage: 'reading_pages', passed: ['uploading', 'reading_text'], pages: { total: 2, done: 0, again: 0, againDone: 0 }, secondRead: null });

  store.report(id, { kind: 'page', page: 2, of: 2, state: 'finished' });
  assert.equal(view().pages!.done, 1);
  store.report(id, { kind: 'page', page: 1, of: 2, state: 'finished' });
  // A short page read again, more strictly.
  store.report(id, { kind: 'page', page: 1, of: 2, state: 'started', again: true });
  assert.deepEqual(view().pages, { total: 2, done: 2, again: 1, againDone: 0 });
  store.report(id, { kind: 'page', page: 1, of: 2, state: 'finished', again: true });

  store.report(id, { kind: 'cross_check' });
  store.advance(id, 'matching');
  assert.deepEqual(view().passed, ['uploading', 'reading_text', 'reading_pages', 'cross_checking']);
  assert.equal(view().stage, 'matching');
  store.advance(id, 'done');
  assert.equal(view().stage, 'done');
});

test('a photo: no text step, the second reading is reported alongside the pages, and steps never go backwards', () => {
  const store = new UploadProgressStore();
  const id = randomUUID();
  store.start(id, venueA);
  store.report(id, { kind: 'second_read', state: 'started' });
  store.report(id, { kind: 'page', page: 1, of: 1, state: 'started' });
  store.report(id, { kind: 'page', page: 1, of: 1, state: 'finished' });
  let r = store.read(id, venueA);
  assert.ok(r.status === 'ok');
  assert.equal(r.view.secondRead, 'running');
  assert.deepEqual(r.view.passed, ['uploading']);
  store.report(id, { kind: 'second_read', state: 'finished' });
  store.report(id, { kind: 'cross_check' });
  // A late report from an earlier step changes nothing.
  store.report(id, { kind: 'text' });
  r = store.read(id, venueA);
  assert.ok(r.status === 'ok');
  assert.equal(r.view.stage, 'cross_checking');
  assert.equal(r.view.secondRead, 'done');
  assert.deepEqual(r.view.passed, ['uploading', 'reading_pages']);
});

test('only the venue and session that started an upload may read it: another venue gets not_found, another session forbidden', () => {
  const store = new UploadProgressStore();
  const id = randomUUID();
  store.start(id, venueA);
  assert.deepEqual(store.read(id, { locationId: 'venue-b', sessionKey: 'session-a' }), { status: 'not_found' });
  assert.deepEqual(store.read(id, { locationId: 'venue-a', sessionKey: 'session-other' }), { status: 'forbidden' });
  assert.deepEqual(store.read(randomUUID(), venueA), { status: 'not_found' });
  // Nobody else can take over an id in use (their upload just isn't tracked).
  assert.equal(store.start(id, { locationId: 'venue-b', sessionKey: 'session-b' }), false);
  assert.equal(store.read(id, venueA).status, 'ok');
});

test('a malformed id is never tracked', () => {
  const store = new UploadProgressStore();
  assert.equal(store.start('not-a-uuid', venueA), false);
  assert.equal(store.start('../../etc', venueA), false);
  assert.equal(store.size(), 0);
});

test('entries expire: TTL after the last change while reading, sooner once the upload answered', () => {
  const c = clock();
  const store = new UploadProgressStore(c.now);
  const slow = randomUUID();
  const finished = randomUUID();
  store.start(slow, venueA);
  store.start(finished, venueA);
  store.advance(finished, 'done');

  c.advance(UPLOAD_PROGRESS_FINISHED_TTL_MS + 1);
  assert.equal(store.read(finished, venueA).status, 'not_found', 'a finished upload is dropped after a minute');
  assert.equal(store.read(slow, venueA).status, 'ok');

  // Each report pushes the expiry out again.
  store.report(slow, { kind: 'text' });
  c.advance(UPLOAD_PROGRESS_TTL_MS - 10_000);
  store.report(slow, { kind: 'page', page: 1, of: 1, state: 'started' });
  c.advance(20_000);
  assert.equal(store.read(slow, venueA).status, 'ok');
  c.advance(UPLOAD_PROGRESS_TTL_MS);
  assert.equal(store.read(slow, venueA).status, 'not_found');
  assert.equal(store.size(), 0);
});
