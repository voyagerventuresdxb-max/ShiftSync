import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as XLSXNS from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { RosterExtractionAnomalyError } from '../parsing/deterministicGridParser.js';
import { MockVisionProvider, VisionProviderError, __setVisionProviderForTests, type VisionInput } from '../parsing/visionProvider.js';
import { __setGridParserForTests, __setReadingCacheForTests } from './schedules.js';

/**
 * POST /api/schedules/upload — when a roster goes to the AI reader (and when it must not).
 * The vision provider is a mock (no network, nothing paid); everything else — the route, the
 * deterministic parsers, the consent gate, the weekly allowance — is the real code against the
 * branch schema.
 */
const XLSX: typeof XLSXNS = ((XLSXNS as unknown as { default?: typeof XLSXNS }).default ?? XLSXNS) as typeof XLSXNS;
const prisma = new PrismaClient();
const PNG = readFileSync('server/scripts/fixtures/vlm-check-roster.png');
const AI_NAME = 'Zed Testperson';
// The AI reader's transcription (vlmPrompt.ts schema): one day column, one person.
const AI_RESPONSE = JSON.stringify({
  title: null,
  days: ['03/03/2031'],
  key: [],
  pages: [{ p: 1, rows: 1, sec: [{ h: null, n: 1, ppl: [{ nm: AI_NAME, t: 'Bartender', i: 1, c: ['10-18'] }] }], unread: [] }],
});
// The same reading, column by column: a photo or scan is read both ways and the two compared.
const AI_COLUMN_RESPONSE = JSON.stringify({
  title: null,
  days: ['03/03/2031'],
  key: [],
  pages: [{ p: 1, rows: 1, ppl: [{ i: 1, nm: AI_NAME, t: 'Bartender', h: null }], cols: [{ d: 0, c: [{ i: 1, x: '10-18' }] }], unread: [] }],
});
const aiReader = () =>
  new MockVisionProvider((input: VisionInput) => ({ raw: input.framing === 'columns' ? AI_COLUMN_RESPONSE : AI_RESPONSE, model: 'mock-model', usage: { promptTokens: null, outputTokens: null } }));

let locationId = '';
let staffToken = '';
const savedEnv = { project: process.env.GEMINI_VERTEX_PROJECT, key: process.env.GEMINI_API_KEY, share: process.env.ROSTER_ESCALATE_EMPTY_ROLE_SHARE };

before(async () => {
  delete process.env.GEMINI_VERTEX_PROJECT;
  delete process.env.GEMINI_API_KEY;
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist');
  const location = await prisma.location.create({
    data: { organizationId: seed!.organizationId, name: '__escalation-test__ venue', timezone: 'Asia/Dubai' },
  });
  locationId = location.id;
  const staff = await prisma.user.create({ data: { locationId, fullName: '__escalation-test__ staff', systemRole: 'STAFF' } });
  staffToken = (await issueSession(staff.id)).plainToken;
});

beforeEach(async () => {
  __setVisionProviderForTests(null);
  __setGridParserForTests(null);
  // These tests are about the gates; each starts with no cached AI reading (see readingCache tests).
  __setReadingCacheForTests(null);
  delete process.env.ROSTER_ESCALATE_EMPTY_ROLE_SHARE;
  delete process.env.AI_VISION_WEEKLY_LIMIT;
  await prisma.location.update({ where: { id: locationId }, data: { lastVisionFallbackUsedAt: null, visionFallbackUses: [] } });
});

after(async () => {
  __setVisionProviderForTests(null);
  __setGridParserForTests(null);
  __setReadingCacheForTests(undefined);
  for (const [k, v] of [['GEMINI_VERTEX_PROJECT', savedEnv.project], ['GEMINI_API_KEY', savedEnv.key], ['ROSTER_ESCALATE_EMPTY_ROLE_SHARE', savedEnv.share]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await prisma.session.deleteMany({ where: { user: { locationId } } });
  await prisma.user.deleteMany({ where: { locationId } });
  await prisma.location.delete({ where: { id: locationId } });
  await prisma.$disconnect();
});

/** A new manager per upload: the route's limiter allows 10 uploads per user per 5 minutes. */
async function freshManagerToken(): Promise<string> {
  const manager = await prisma.user.create({ data: { locationId, fullName: '__escalation-test__ manager', systemRole: 'MANAGER' } });
  return (await issueSession(manager.id)).plainToken;
}

function xlsx(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Roster');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Day-grid with real roles (vocabulary headers) — the deterministic parser reads it cleanly. */
const CLEAN_GRID = xlsx([
  ['', 'Monday', 'Tuesday'],
  ['SUPERVISORS', '', ''],
  ['Test Alpha', '9-17', '9-17'],
  ['RUNNERS', '', ''],
  ['Test Beta', '10-18', '10-18'],
]);
/** No section headers at all: every shift row has an empty role. */
const NO_ROLES_GRID = xlsx([
  ['', 'Monday', 'Tuesday'],
  ['Test Alpha', '9-17', '9-17'],
  ['Test Beta', '10-18', '10-18'],
]);
/** Every staff name in capitals. */
const ALL_CAPS_GRID = xlsx([
  ['', 'Monday', 'Tuesday'],
  ['SUPERVISORS', '', ''],
  ['TEST ALPHA', '9-17', '9-17'],
  ['TEST BETA', '10-18', '10-18'],
]);

async function upload(
  file: { data: Buffer; name: string; type: string },
  opts: { token?: string; aiConsent?: boolean } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
    form.append('weekStart', '2031-03-03');
    if (opts.aiConsent) form.append('aiConsent', 'true');
    const res = await fetch(`http://127.0.0.1:${port}/api/schedules/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.token ?? (await freshManagerToken())}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const image = { data: PNG, name: 'roster.png', type: 'image/png' };
const sheet = (data: Buffer) => ({ data, name: 'roster.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

async function allowanceUsed(): Promise<boolean> {
  const loc = await prisma.location.findUnique({ where: { id: locationId }, select: { lastVisionFallbackUsedAt: true, visionFallbackUses: true } });
  return loc?.lastVisionFallbackUsedAt != null && loc.visionFallbackUses.length > 0;
}

test('a STAFF session cannot upload a roster (an AI read costs the venue): 403', async () => {
  const { status } = await upload(sheet(CLEAN_GRID), { token: staffToken });
  assert.equal(status, 403);
});

test('image, AI configured, no consent: 422 ai_consent_required and nothing is sent', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const { status, body } = await upload(image);
  assert.equal(status, 422);
  assert.equal(body.errorCode, 'ai_consent_required');
  assert.equal(body.escalationReason, 'image_or_scan');
  assert.match(body.error, /third-party service outside the UAE/);
  assert.equal(mock.calls.length, 0);
  assert.equal(await allowanceUsed(), false);
});

test('image with consent: read by the provider, preview returned, weekly allowance recorded', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const { status, body } = await upload(image, { aiConsent: true });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(mock.calls.map((c) => c.framing ?? 'rows').sort(), ['columns', 'rows'], 'a photo is read twice, person by person and day by day');
  assert.equal(mock.calls[0]!.kind, 'file');
  assert.equal(body.preview[0].employeeName, AI_NAME);
  assert.equal(await allowanceUsed(), true);
});

test('image with consent but the weekly allowance already used: 422 with the manual path, nothing sent', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  await prisma.location.update({ where: { id: locationId }, data: { lastVisionFallbackUsedAt: new Date(), visionFallbackUses: [new Date()] } });
  const { status, body } = await upload(image, { aiConsent: true });
  assert.equal(status, 422);
  assert.equal(body.errorCode, 'vision_fallback_blocked');
  assert.match(body.error, /limited to once per venue per week/);
  assert.match(body.error, /People → Add staff member/);
  assert.equal(mock.calls.length, 0);
});

test('AI_VISION_WEEKLY_LIMIT=2: a second read this week goes through, a third is refused; reads older than 7 days do not count', async () => {
  process.env.AI_VISION_WEEKLY_LIMIT = '2';
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await prisma.location.update({ where: { id: locationId }, data: { visionFallbackUses: [eightDaysAgo, new Date()] } });
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  assert.equal((await upload(image, { aiConsent: true })).status, 200);
  assert.equal(mock.calls.length, 2);
  const loc = await prisma.location.findUniqueOrThrow({ where: { id: locationId }, select: { visionFallbackUses: true } });
  assert.equal(loc.visionFallbackUses.length, 2, 'the expired read was dropped, the new one recorded');
  const third = await upload(image, { aiConsent: true });
  assert.equal(third.status, 422);
  assert.match(third.body.error, /limited to 2 times per venue per week/);
  assert.equal(mock.calls.length, 2);
});

test('AI_VISION_WEEKLY_LIMIT=0: AI roster reading is off, nothing sent', async () => {
  process.env.AI_VISION_WEEKLY_LIMIT = '0';
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const { status, body } = await upload(image, { aiConsent: true });
  assert.equal(status, 422);
  assert.match(body.error, /switched off on this server/);
  assert.equal(mock.calls.length, 0);
});

test('image over the 5 MB AI cap: 422, nothing sent', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
  const { status, body } = await upload({ ...image, data: big }, { aiConsent: true });
  assert.equal(status, 422);
  assert.equal(body.errorCode, 'vision_fallback_blocked');
  assert.match(body.error, /5MB/);
  assert.equal(mock.calls.length, 0);
});

test('image with no AI configured: 422 vision_unconfigured naming Excel/CSV and the manual path', async () => {
  const { status, body } = await upload(image);
  assert.equal(status, 422);
  assert.equal(body.errorCode, 'vision_unconfigured');
  assert.match(body.error, /Excel\/CSV/);
  assert.match(body.error, /People → Add staff member/);
});

test('image, provider answers but every model is retired: 422 vision_model_unavailable, allowance untouched', async () => {
  __setVisionProviderForTests(
    new MockVisionProvider(() => {
      throw new VisionProviderError('No configured vision model is available.', 'model_unavailable');
    }),
  );
  const { status, body } = await upload(image, { aiConsent: true });
  assert.equal(status, 422);
  assert.equal(body.errorCode, 'vision_model_unavailable');
  assert.equal(await allowanceUsed(), false);
});

test('a clean spreadsheet never goes to the AI reader, even when one is configured', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const { status, body } = await upload(sheet(CLEAN_GRID), { aiConsent: true });
  assert.equal(status, 200);
  assert.equal(body.templateDetected, 'Deterministic Grid Parser');
  assert.equal(body.escalation, undefined);
  assert.equal(mock.calls.length, 0);
});

test('too many empty roles, no consent: the local result is shown with an escalation offer; nothing sent', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const { status, body } = await upload(sheet(NO_ROLES_GRID));
  assert.equal(status, 200);
  assert.equal(body.templateDetected, 'Deterministic Grid Parser');
  assert.deepEqual([body.escalation.reason, body.escalation.status], ['empty_roles', 'needs_consent']);
  assert.equal(mock.calls.length, 0);
});

test('too many empty roles, with consent: the grid goes to the provider as text and is cross-checked against the local reading', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const { status, body } = await upload(sheet(NO_ROLES_GRID), { aiConsent: true });
  assert.equal(status, 200);
  assert.deepEqual([body.escalation.reason, body.escalation.status], ['empty_roles', 'used']);
  assert.equal((mock.calls[0] as VisionInput).kind, 'grid');
  // The AI's person is primary; the people only the built-in reader found stay, marked as such —
  // nobody is dropped. Their shifts, read from the file's own cells, carry no flag of their own.
  assert.equal(body.preview[0].employeeName, AI_NAME);
  assert.deepEqual(body.preview[0].flags, ['ai_only']);
  assert.deepEqual(body.readPeople.map((p: { name: string; readerSource: string }) => `${p.name}|${p.readerSource}`), [`${AI_NAME}|ai`, 'Test Alpha|table', 'Test Beta|table']);
  assert.ok(body.people.filter((p: { name: string }) => p.name === 'Test Alpha').every((p: { flags: { kind: string }[] }) => p.flags.some((f) => f.kind === 'table_only')));
  assert.ok(body.preview.filter((r: { employeeName: string }) => r.employeeName === 'Test Alpha').every((r: { flags?: string[] }) => !r.flags));
  assert.equal(body.reading.ai, 'used');
  assert.ok(body.reading.disagreements >= 3);
  assert.equal(await allowanceUsed(), true);
});

test('the empty-role share is configurable: ROSTER_ESCALATE_EMPTY_ROLE_SHARE=1 never escalates on roles', async () => {
  __setVisionProviderForTests(aiReader());
  process.env.ROSTER_ESCALATE_EMPTY_ROLE_SHARE = '1';
  const { body } = await upload(sheet(NO_ROLES_GRID));
  assert.equal(body.escalation, undefined);
});

test('ALL-CAPS venue: escalation offered with its own reason', async () => {
  __setVisionProviderForTests(aiReader());
  const { status, body } = await upload(sheet(ALL_CAPS_GRID));
  assert.equal(status, 200);
  assert.deepEqual([body.escalation.reason, body.escalation.status], ['all_caps_venue', 'needs_consent']);
});

test('escalation with consent but the AI read fails: the local result stays, with a clear note', async () => {
  __setVisionProviderForTests(
    new MockVisionProvider(() => {
      throw new VisionProviderError('busy', 'busy');
    }),
  );
  const { status, body } = await upload(sheet(NO_ROLES_GRID), { aiConsent: true });
  assert.equal(status, 200);
  assert.equal(body.templateDetected, 'Deterministic Grid Parser');
  assert.deepEqual([body.escalation.reason, body.escalation.status], ['empty_roles', 'unavailable']);
  assert.match(body.escalation.message, /built-in reader's result is shown instead/);
  assert.equal(await allowanceUsed(), false);
});

test('no AI configured: a suspect local result is returned as-is, with no escalation offer', async () => {
  const { status, body } = await upload(sheet(NO_ROLES_GRID));
  assert.equal(status, 200);
  assert.equal(body.escalation, undefined);
});

test('grid parser proves it dropped data: with no AI, 422 roster_extraction_anomaly naming the manual path', async () => {
  __setGridParserForTests(() => {
    throw new RosterExtractionAnomalyError('Found real shift data on 3 row(s) of the uploaded file, but only 2 could be matched to an employee.');
  });
  const { status, body } = await upload(sheet(CLEAN_GRID));
  assert.equal(status, 422);
  assert.equal(body.errorCode, 'roster_extraction_anomaly');
  assert.match(body.error, /People → Add staff member/);
});

test('grid parser proves it dropped data: AI configured asks for consent, then reads the grid', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  __setGridParserForTests(() => {
    throw new RosterExtractionAnomalyError('dropped');
  });
  const ask = await upload(sheet(CLEAN_GRID));
  assert.equal(ask.status, 422);
  assert.deepEqual([ask.body.errorCode, ask.body.escalationReason], ['ai_consent_required', 'extraction_anomaly']);
  assert.equal(mock.calls.length, 0);

  const read = await upload(sheet(CLEAN_GRID), { aiConsent: true });
  assert.equal(read.status, 200);
  assert.deepEqual([read.body.escalation.reason, read.body.escalation.status], ['extraction_anomaly', 'used']);
  assert.equal(mock.calls[0]!.kind, 'grid');
});

test('a layout no local parser recognises asks for consent before going to the AI reader', async () => {
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const daysAsRows = xlsx([
    ['Day', 'Test Alpha', 'Test Beta'],
    ['Notes', 'x', 'y'],
  ]);
  const { status, body } = await upload(sheet(daysAsRows));
  assert.equal(status, 422);
  assert.deepEqual([body.errorCode, body.escalationReason], ['ai_consent_required', 'unrecognized_layout']);
  assert.equal(mock.calls.length, 0);
});

// --- the reading in the upload response (rosterContract.ts) ---------------------------------------

test('upload response: every person read (no-shift people too), unread rows, the printed week and the reading report; preview rows carry their reading', async () => {
  // The client sends weekStart 2031-03-03, but the roster prints its own dates: those win.
  const printed = xlsx([
    ['', '24-Aug', '25-Aug'],
    ['', 'MONDAY', 'TUESDAY'],
    ['SUPERVISORS', '', ''],
    ['Test Alpha', '9-17', '9-17'],
    ['Test Blank', '', ''],
  ]);
  const { status, body } = await upload(sheet(printed));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.readPeople.map((p: { name: string; section: string; readerSource: string }) => `${p.name}|${p.section}|${p.readerSource}`), ['Test Alpha|SUPERVISORS|table', 'Test Blank|SUPERVISORS|table']);
  assert.deepEqual(body.unreadRows, []);
  assert.equal(body.week.weekStart, '2026-08-24');
  assert.equal(body.week.source, 'printed_dates');
  assert.deepEqual(body.reading, { ai: 'not_used', table: 'used', rowsDetected: 2, peopleFound: 2, rereadPages: [], disagreements: 0, fromCache: false, note: 'Read by the built-in reader only.' });
  assert.deepEqual(body.preview.map((r: { date: string }) => r.date), ['2026-08-24', '2026-08-25']);
  assert.equal(body.preview[0].personKey, body.readPeople[0].personKey);
  assert.equal(body.preview[0].section, 'SUPERVISORS');
  assert.equal(body.preview[0].readerSource, 'table');
});

test('upload response: a weekday-only roster uses the week the client sent', async () => {
  const { status, body } = await upload(sheet(CLEAN_GRID));
  assert.equal(status, 200);
  assert.equal(body.week.weekStart, '2031-03-03');
  assert.equal(body.week.needsConfirmation, false);
  assert.deepEqual([...new Set(body.preview.map((r: { date: string }) => r.date))], ['2031-03-03', '2031-03-04']);
});

test('the same photo uploaded again is read from the venue\'s cache: no AI call, no allowance, no consent needed', async () => {
  __setReadingCacheForTests(undefined); // the real per-venue cache table
  const mock = aiReader();
  __setVisionProviderForTests(mock);
  const first = await upload(image, { aiConsent: true });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.reading.ai, 'used');
  await prisma.location.update({ where: { id: locationId }, data: { lastVisionFallbackUsedAt: null, visionFallbackUses: [] } });
  const again = await upload(image);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.reading.ai, again.body.reading.fromCache], ['cached', true]);
  assert.equal(mock.calls.length, 2, 'no further model call');
  assert.equal(await allowanceUsed(), false, 'no allowance used for the cached read');
  assert.equal(again.body.preview[0].employeeName, AI_NAME);
  assert.equal(await prisma.rosterReadingCache.count({ where: { locationId } }), 1);
});
