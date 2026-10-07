import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { MockVisionProvider, __setVisionProviderForTests, type VisionInput } from '../parsing/visionProvider.js';
import { __setReadingCacheForTests } from './schedules.js';

/**
 * GET /api/schedules/upload-progress/:uploadId — the steps of a real upload as the route records
 * them (store/uploadProgress.ts), read while the upload is still open. The AI reader is a mock
 * that answers each page only when the test lets it, so every step can be looked at in turn.
 * Made-up names; no network beyond 127.0.0.1.
 */
const prisma = new PrismaClient();
const TAG = '__upload-progress-test__';
const PNG = readFileSync('server/scripts/fixtures/vlm-check-roster.png');

let server: Server;
let baseUrl = '';
const orgIds: string[] = [];
const tokens = { manager: '', managerOtherSession: '', staff: '', otherVenueManager: '' };
const savedWeeklyLimit = process.env.AI_VISION_WEEKLY_LIMIT;

async function twoPagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const name of ['Quill Ambersmith', 'Rowan Tidewell']) {
    const page = doc.addPage([700, 400]);
    for (const item of [
      { text: 'Monday', x: 140, y: 380 },
      { text: 'Tuesday', x: 240, y: 380 },
      { text: name, x: 20, y: 360 },
      { text: '9-17', x: 140, y: 360 },
      { text: '9-17', x: 240, y: 360 },
    ]) {
      page.drawText(item.text, { x: item.x, y: item.y, size: 10, font });
    }
  }
  return Buffer.from(await doc.save());
}

/** The AI reader's answer for one page (vlmPrompt.ts schema). */
const pageAnswer = (page: number) =>
  JSON.stringify({
    title: null,
    days: ['Monday', 'Tuesday'],
    key: [],
    pages: [{ p: page, rows: 1, sec: [{ h: null, n: 1, ppl: [{ nm: page === 1 ? 'Quill Ambersmith' : 'Rowan Tidewell', t: null, i: 1, c: ['9-17', '9-17'] }] }], unread: [] }],
  });

before(async () => {
  const user = async (locationId: string, systemRole: 'MANAGER' | 'STAFF', label: string) =>
    prisma.user.create({ data: { locationId, systemRole, fullName: `${TAG} ${label}` } });
  const venue = async (label: string) => {
    const org = await prisma.organization.create({ data: { name: `${TAG} ${label}` } });
    orgIds.push(org.id);
    return prisma.location.create({ data: { organizationId: org.id, name: `${TAG} ${label}`, timezone: 'Asia/Dubai' } });
  };
  const a = await venue('venue A');
  const b = await venue('venue B');
  const manager = await user(a.id, 'MANAGER', 'manager A');
  tokens.manager = (await issueSession(manager.id)).plainToken;
  tokens.managerOtherSession = (await issueSession(manager.id)).plainToken;
  tokens.staff = (await issueSession((await user(a.id, 'STAFF', 'staff A')).id)).plainToken;
  tokens.otherVenueManager = (await issueSession((await user(b.id, 'MANAGER', 'manager B')).id)).plainToken;
  __setReadingCacheForTests(null);
  // More than one AI read at this venue this week.
  process.env.AI_VISION_WEEKLY_LIMIT = '20';
  server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  __setVisionProviderForTests(null);
  __setReadingCacheForTests(undefined);
  if (savedWeeklyLimit === undefined) delete process.env.AI_VISION_WEEKLY_LIMIT;
  else process.env.AI_VISION_WEEKLY_LIMIT = savedWeeklyLimit;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

function upload(file: { data: Buffer; name: string; type: string }, uploadId: string, aiConsent: boolean) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
  form.append('weekStart', '2031-03-03');
  if (aiConsent) form.append('aiConsent', 'true');
  return fetch(`${baseUrl}/api/schedules/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.manager}`, 'X-Upload-Id': uploadId }, body: form });
}

async function progress(uploadId: string, token: string | null = tokens.manager) {
  const res = await fetch(`${baseUrl}/api/schedules/upload-progress/${uploadId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** Polls until `done` holds (the upload runs on its own meanwhile). */
async function until(uploadId: string, done: (body: Record<string, any>) => boolean): Promise<Record<string, any>> {
  for (let i = 0; i < 250; i++) {
    const { status, body } = await progress(uploadId);
    if (status === 200 && done(body)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`progress never reached the expected state: ${JSON.stringify((await progress(uploadId)).body)}`);
}

test('a two-page text PDF: the steps are recorded in order, page by page, and only its own venue and session can read them', async () => {
  const release = new Map<number, () => void>();
  const answered = new Map([1, 2].map((p) => [p, new Promise<void>((resolve) => release.set(p, resolve))]));
  __setVisionProviderForTests(
    new MockVisionProvider(async (input: VisionInput) => {
      const page = input.focus?.page ?? 1;
      await answered.get(page);
      return { raw: pageAnswer(page), model: 'mock-model', usage: { promptTokens: null, outputTokens: null } };
    }),
  );
  const id = randomUUID();
  const pending = upload({ data: await twoPagePdf(), name: 'two-pages.pdf', type: 'application/pdf' }, id, true);

  const reading = await until(id, (b) => b.stage === 'reading_pages');
  assert.deepEqual(reading, { stage: 'reading_pages', passed: ['uploading', 'reading_text'], pages: { total: 2, done: 0, again: 0, againDone: 0 }, secondRead: null });

  // Nobody else can follow it: another venue gets the same 404 as an unknown id, another session a 403.
  const otherVenue = await progress(id, tokens.otherVenueManager);
  assert.equal(otherVenue.status, 404);
  assert.equal(otherVenue.body.errorCode, 'upload_progress_unknown');
  assert.equal((await progress(id, tokens.managerOtherSession)).status, 403);
  assert.equal((await progress(id, tokens.staff)).status, 403);
  assert.equal((await progress(id, null)).status, 401);
  const unknown = await progress(randomUUID());
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.errorCode, 'upload_progress_unknown');
  assert.equal((await progress('not-an-id')).status, 404);

  release.get(1)!();
  const half = await until(id, (b) => b.pages?.done === 1);
  assert.equal(half.stage, 'reading_pages');
  release.get(2)!();

  const res = await pending;
  const body = (await res.json()) as { reading: { table: string } };
  assert.equal(res.status, 200);
  const done = await until(id, (b) => b.stage === 'done');
  const expected = ['uploading', 'reading_text', 'reading_pages', ...(body.reading.table === 'used' ? ['cross_checking'] : []), 'matching'];
  assert.deepEqual(done.passed, expected);
  assert.deepEqual(done.pages, { total: 2, done: 2, again: 0, againDone: 0 });
  // Stages and counts only: nothing read from the file is in it.
  assert.doesNotMatch(JSON.stringify(done), /Quill|Rowan|9-17/);
});

test('a photo: the second reading is reported while it runs; an upload refused for consent ends as failed', async () => {
  let releaseColumns!: () => void;
  const columnsAnswered = new Promise<void>((resolve) => (releaseColumns = resolve));
  const columns = JSON.stringify({
    title: null,
    days: ['Monday'],
    key: [],
    pages: [{ p: 1, rows: 1, ppl: [{ i: 1, nm: 'Quill Ambersmith', t: null, h: null }], cols: [{ d: 0, c: [{ i: 1, x: '9-17' }] }], unread: [] }],
  });
  __setVisionProviderForTests(
    new MockVisionProvider(async (input: VisionInput) => {
      if (input.framing === 'columns') await columnsAnswered;
      return { raw: input.framing === 'columns' ? columns : pageAnswer(1), model: 'mock-model', usage: { promptTokens: null, outputTokens: null } };
    }),
  );
  const image = { data: PNG, name: 'photo.png', type: 'image/png' };

  const id = randomUUID();
  const pending = upload(image, id, true);
  const second = await until(id, (b) => b.pages?.done === 1 && b.secondRead === 'running');
  assert.deepEqual(second.passed, ['uploading']);
  releaseColumns();
  assert.equal((await pending).status, 200);
  const done = await until(id, (b) => b.stage === 'done');
  assert.equal(done.secondRead, 'done');
  assert.deepEqual(done.passed, ['uploading', 'reading_pages', 'cross_checking', 'matching']);

  const refusedId = randomUUID();
  const refused = await upload(image, refusedId, false);
  assert.equal(refused.status, 422);
  await until(refusedId, (b) => b.stage === 'failed');
});
