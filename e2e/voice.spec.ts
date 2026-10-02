import { test, expect, type Page } from '@playwright/test';
import type { SystemRole } from '@prisma/client';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';
import { geminiCalls, resetFakeGemini, scriptUtterance, type GeminiCall } from './fakeGemini';

/**
 * Voice commands end to end: mic → /transcribe → /parse-intent → confirm
 * sheet → /execute, through the real API and DB. Only Gemini is faked, at
 * the network boundary (e2e/fakeGemini.ts, reached via GEMINI_BASE_URL), so
 * each test scripts what the "model" hears and returns. Chromium's fake
 * microphone supplies the audio.
 *
 * The first test is Slice 3's never-run manual smoke test (compound-request
 * plan, Task 8 Step 3); the rest drive one confirm → execute per v2 category
 * plus the confidence gate and role scoping.
 */

test.use({
  permissions: ['microphone'],
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

const FOLLOW_UP = "I heard something else in there too — what's the next thing you'd like me to do?";
const usedPhones: string[] = [];

function freshPhone(): string {
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  return phone;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** The next Monday strictly after today — always a future week, whatever day the suite runs. */
function nextMonday(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return isoDate(d);
}

async function createVenue(label: string) {
  const org = await prisma.organization.create({ data: { name: testVenueName(`voice-${label}`) } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Bartender' } });
  return { locationId: location.id, roleId: role.id };
}

async function createUser(locationId: string, systemRole: SystemRole, fullName: string, phone: string | null = null) {
  return prisma.user.create({ data: { locationId, systemRole, fullName, phone } });
}

/** Same one-retry cold-Vite guard as helpers.ts `signupNewVenue`. */
async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

async function logIn(page: Page, phone: string, landing: '/' | '/my-shifts'): Promise<void> {
  await open(page, '/login');
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname === landing);
}

/** Scripts what the fake Gemini hears and returns, then records a real (fake-device) clip with the mic button. */
async function speak(page: Page, transcript: string, intent: Record<string, unknown>): Promise<void> {
  await scriptUtterance(transcript, intent);
  await page.getByRole('button', { name: 'Start recording a voice command' }).click();
  const stop = page.getByRole('button', { name: 'Stop recording voice command' });
  await expect(stop).toBeVisible();
  await page.waitForTimeout(700);
  // While listening the button "breathes" (an endless scale animation), so it never passes Playwright's stability check.
  await stop.click({ force: true });
}

/** The confirm sheet — the one panel that echoes the transcript back. */
function sheetFor(page: Page, transcript: string) {
  return page.locator('.panel').filter({ hasText: `You said: “${transcript}”` });
}

async function voiceLogs(actorId: string) {
  return prisma.voiceInteractionLog.findMany({ where: { actorId }, orderBy: { createdAt: 'asc' } });
}

/** The parse call's `intent` enum — what the model was structurally allowed to answer for this caller. */
function intentEnum(call: GeminiCall): unknown {
  const config = call.body.generationConfig as { responseSchema?: { properties?: { intent?: { enum?: unknown } } } } | undefined;
  return config?.responseSchema?.properties?.intent?.enum;
}

/** Each parse call received exactly the text the transcribe call before it returned. */
async function expectPipeline(transcripts: string[]): Promise<GeminiCall[]> {
  const calls = await geminiCalls();
  expect(calls.map((c) => c.kind)).toEqual(transcripts.flatMap(() => ['transcribe', 'parse']));
  transcripts.forEach((transcript, i) => {
    const audio = calls[i * 2]!.body.contents?.[0]?.parts?.find((p) => p.inlineData)?.inlineData;
    expect(audio?.mimeType).toMatch(/^audio\//);
    expect(audio?.data.length).toBeGreaterThan(0);
    expect(calls[i * 2 + 1]!.body.contents?.[0]?.parts?.[0]?.text).toBe(transcript);
  });
  return calls;
}

test.describe('voice commands — real pipeline, Gemini faked at the network boundary', () => {
  test.beforeEach(async () => {
    await resetFakeGemini();
  });

  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('compound request: confirms only the primary intent, then asks for the rest, which runs as its own command', async ({ page }) => {
    const { locationId, roleId } = await createVenue('compound');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const layla = await createUser(locationId, 'STAFF', 'Layla Haddad');
    const saturday = addDays(nextMonday(), 5);

    await logIn(page, managerPhone, '/');

    const first = 'Create a bartender shift for Layla on Saturday 6pm to 2am and give her a shoutout for covering last night';
    const createSummary = `Create a Bartender shift for Layla Haddad on ${saturday}, 18:00 to 02:00.`;
    await speak(page, first, {
      intent: 'CREATE_SHIFT', roleId, date: saturday, start: '18:00', end: '02:00', userId: layla.id,
      confidence: 0.93, hasAdditionalRequest: true, summary: createSummary,
    });

    // Before executing: the plain confirm view for the primary intent, no follow-up copy yet.
    const sheet = sheetFor(page, first);
    await expect(sheet.locator('.eyebrow')).toHaveText('Confirm voice command');
    await expect(sheet.getByText(createSummary, { exact: true })).toBeVisible();
    await expect(sheet.getByText(FOLLOW_UP)).toHaveCount(0);
    expect(await prisma.shift.count({ where: { locationId } })).toBe(0);

    // Confirm → the same sheet turns into the follow-up state; no success banner.
    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(sheet.locator('.eyebrow')).toHaveText('Got it — one more thing?');
    await expect(sheet.getByText(`Done: ${createSummary}`, { exact: true })).toBeVisible();
    await expect(sheet.getByText(FOLLOW_UP)).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await expect(page.locator('.success-block')).toHaveCount(0);

    const shift = await prisma.shift.findFirstOrThrow({ where: { locationId } });
    expect(shift).toMatchObject({ roleId, userId: layla.id, createdById: manager.id, status: 'DRAFT' });
    expect(isoDate(shift.date)).toBe(saturday);
    // Asia/Dubai (UTC+4): 18:00 → 14:00Z, and the overnight 02:00 end → 22:00Z the same UTC day.
    expect(shift.startTime.toISOString()).toBe(`${saturday}T14:00:00.000Z`);
    expect(shift.endTime.toISOString()).toBe(`${saturday}T22:00:00.000Z`);
    const shiftAudit = await prisma.auditLog.findFirstOrThrow({ where: { locationId, action: 'SHIFT_CREATED' } });
    expect(shiftAudit).toMatchObject({ actorId: manager.id, entityId: shift.id, note: `[voice] "${first}"` });

    // "Got it" closes it, still with no success banner.
    await sheet.getByRole('button', { name: 'Got it' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.success-block')).toHaveCount(0);

    // The rest of the request, said again, is parsed and confirmed on its own.
    const second = 'Give Layla a shoutout for covering last night';
    const note = 'Thanks for covering last night, Layla!';
    await speak(page, second, {
      intent: 'POST_SHOUTOUT', targetUserId: layla.id, targetUserName: 'Layla Haddad', content: note,
      confidence: 0.9, hasAdditionalRequest: false, summary: 'Post a shoutout for Layla Haddad.',
    });
    const sheet2 = sheetFor(page, second);
    await expect(sheet2.locator('.eyebrow')).toHaveText('Confirm voice command');
    await expect(sheet2.getByText(`“${note}”`, { exact: true })).toBeVisible();
    await expect(sheet2.getByText(FOLLOW_UP)).toHaveCount(0);
    await sheet2.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText('Post a shoutout for Layla Haddad.');
    await expect(sheet2).toHaveCount(0);

    const shoutout = await prisma.shoutout.findFirstOrThrow({ where: { locationId } });
    expect(shoutout).toMatchObject({ employeeId: layla.id, authorId: manager.id, note, shiftSnapshot: null });

    const logs = await voiceLogs(manager.id);
    expect(logs.map((l) => [l.resolvedIntent, l.hasAdditionalRequest, l.outcome, l.transcript])).toEqual([
      ['CREATE_SHIFT', true, 'EXECUTED', first],
      ['POST_SHOUTOUT', false, 'EXECUTED', second],
    ]);
    expect(logs[0]!.confidence).toBeCloseTo(0.93);
    await expectPipeline([first, second]);
  });

  test('staff: MARK_AVAILABILITY executes with a success banner; QUERY_MY_SCHEDULE only answers; the model only ever sees staff intents', async ({ page }) => {
    const { locationId } = await createVenue('staff');
    const staffPhone = freshPhone();
    const staff = await createUser(locationId, 'STAFF', 'E2E Voice Staff', staffPhone);
    const monday = nextMonday();

    await logIn(page, staffPhone, '/my-shifts');

    const said = 'Mark me unavailable next Monday';
    const summary = `Mark you unavailable on ${monday}.`;
    await speak(page, said, { intent: 'MARK_AVAILABILITY', date: monday, availabilityType: 'UNAVAILABLE', confidence: 0.95, summary });
    const sheet = sheetFor(page, said);
    await expect(sheet.getByText(summary, { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText(summary);
    await expect(sheet).toHaveCount(0);

    const mark = await prisma.availabilityMark.findFirstOrThrow({ where: { userId: staff.id } });
    expect(mark).toMatchObject({ type: 'UNAVAILABLE', note: `[voice] "${said}"` });
    expect(isoDate(mark.date)).toBe(monday);
    expect(await prisma.auditLog.count({ where: { locationId, actorId: staff.id, action: 'AVAILABILITY_MARKED', entityId: mark.id } })).toBe(1);

    const asked = "What's my schedule this week?";
    await speak(page, asked, { intent: 'QUERY_MY_SCHEDULE', confidence: 0.9, summary: 'You have no shifts scheduled this week.' });
    const answer = sheetFor(page, asked);
    await expect(answer.locator('.eyebrow')).toHaveText('Your schedule');
    await expect(answer.getByText('You have no shifts scheduled this week.', { exact: true })).toBeVisible();
    await expect(answer.getByRole('button')).toHaveText(['Got it']);
    await answer.getByRole('button', { name: 'Got it' }).click();
    await expect(answer).toHaveCount(0);

    const logs = await voiceLogs(staff.id);
    expect(logs.map((l) => [l.resolvedIntent, l.outcome])).toEqual([
      ['MARK_AVAILABILITY', 'EXECUTED'],
      ['QUERY_MY_SCHEDULE', 'ANSWERED'],
    ]);
    const calls = await expectPipeline([said, asked]);
    expect(intentEnum(calls[1]!)).toEqual(['MARK_AVAILABILITY', 'REQUEST_SWAP', 'QUERY_MY_SCHEDULE', 'UNRECOGNIZED']);
  });

  test('manager approvals: APPROVE_JOIN turns a pending join request into a real staff member', async ({ page }) => {
    const { locationId } = await createVenue('approve-join');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const applicantPhone = freshPhone();
    const request = await prisma.joinRequest.create({ data: { locationId, phone: applicantPhone, fullName: 'Omar Farouk' } });

    await logIn(page, managerPhone, '/');
    const said = "Approve Omar's request to join";
    const summary = "Approve Omar Farouk's request to join the team.";
    await speak(page, said, { intent: 'APPROVE_JOIN', joinRequestId: request.id, confidence: 0.9, summary });
    const sheet = sheetFor(page, said);
    await expect(sheet.getByText(summary, { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText(summary);

    const decided = await prisma.joinRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(decided).toMatchObject({ status: 'APPROVED', reviewedById: manager.id });
    const created = await prisma.user.findUniqueOrThrow({ where: { phone: applicantPhone } });
    expect(created).toMatchObject({ id: decided.createdUserId, locationId, fullName: 'Omar Farouk', systemRole: 'STAFF', isActive: true });
    // The shared mutator's own audit row, plus the voice row carrying the transcript.
    const audits = await prisma.auditLog.findMany({ where: { locationId, action: 'JOIN_APPROVED', entityId: request.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.note)).toEqual([`Approved join request for Omar Farouk — created User ${created.id}`, `[voice] "${said}"`]);
    expect((await voiceLogs(manager.id)).map((l) => [l.resolvedIntent, l.outcome])).toEqual([['APPROVE_JOIN', 'EXECUTED']]);
    await expectPipeline([said]);
  });

  test('rota: PUBLISH_ROTA previews the real affected counts, then publishes the week', async ({ page }) => {
    const { locationId, roleId } = await createVenue('publish');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const ahmed = await createUser(locationId, 'STAFF', 'Ahmed Khan');
    const fatima = await createUser(locationId, 'STAFF', 'Fatima Al Suwaidi');
    const monday = nextMonday();
    for (const [offset, userId] of [[0, ahmed.id], [1, ahmed.id], [2, fatima.id]] as const) {
      const date = addDays(monday, offset);
      await prisma.shift.create({
        data: { locationId, roleId, userId, date: new Date(`${date}T00:00:00.000Z`), startTime: new Date(`${date}T14:00:00.000Z`), endTime: new Date(`${date}T22:00:00.000Z`) },
      });
    }
    // A shift the week after must not be counted or published.
    const later = addDays(monday, 7);
    await prisma.shift.create({
      data: { locationId, roleId, userId: fatima.id, date: new Date(`${later}T00:00:00.000Z`), startTime: new Date(`${later}T14:00:00.000Z`), endTime: new Date(`${later}T22:00:00.000Z`) },
    });

    await logIn(page, managerPhone, '/');
    const said = "Publish next week's rota";
    // The model's own summary is replaced server-side by the counted preview.
    await speak(page, said, { intent: 'PUBLISH_ROTA', weekStart: monday, confidence: 0.9, summary: 'Publish the rota for next week.' });
    const preview = `This will publish 3 shifts across 2 staff members for the week of ${monday} — confirm?`;
    const sheet = sheetFor(page, said);
    await expect(sheet.getByText(preview, { exact: true })).toBeVisible();
    expect(await prisma.shift.count({ where: { locationId, status: 'PUBLISHED' } })).toBe(0);
    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText(preview);

    const shifts = await prisma.shift.findMany({ where: { locationId }, orderBy: { date: 'asc' } });
    expect(shifts.map((s) => s.status)).toEqual(['PUBLISHED', 'PUBLISHED', 'PUBLISHED', 'DRAFT']);
    const publish = await prisma.rotaPublish.findFirstOrThrow({ where: { locationId } });
    expect(publish).toMatchObject({ publishedById: manager.id, notifiedCount: 2 });
    expect(isoDate(publish.weekStart)).toBe(monday);
    expect((await voiceLogs(manager.id)).map((l) => [l.resolvedIntent, l.outcome])).toEqual([['PUBLISH_ROTA', 'EXECUTED']]);
    await expectPipeline([said]);
  });

  test('rota: APPLY_ROTA_TEMPLATE confirms the matched saved template, then creates its shifts', async ({ page }) => {
    const { locationId, roleId } = await createVenue('template');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const ahmed = await createUser(locationId, 'STAFF', 'Ahmed Khan');
    const template = await prisma.rotaTemplate.create({
      data: {
        locationId,
        name: 'Weekend Bar',
        entries: [
          { dayOffset: 5, roleId, userId: ahmed.id, start: '18:00', end: '23:00' },
          { dayOffset: 6, roleId, userId: null, start: '12:00', end: '20:00' },
        ],
      },
    });
    const monday = nextMonday();

    await logIn(page, managerPhone, '/');
    const said = 'Apply the weekend bar template to next week';
    await speak(page, said, {
      intent: 'APPLY_ROTA_TEMPLATE', templateId: template.id, templateName: 'weekend bar', weekStart: monday,
      confidence: 0.88, summary: 'Apply the weekend bar template.',
    });
    const preview = `Apply template "Weekend Bar" to the week of ${monday} — confirm?`;
    const sheet = sheetFor(page, said);
    await expect(sheet.getByText(preview, { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText(preview);

    const shifts = await prisma.shift.findMany({ where: { locationId }, orderBy: { date: 'asc' } });
    expect(shifts.map((s) => [isoDate(s.date), s.userId, s.status, s.createdById])).toEqual([
      [addDays(monday, 5), ahmed.id, 'DRAFT', manager.id],
      [addDays(monday, 6), null, 'DRAFT', manager.id],
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { locationId, action: 'SHIFT_CREATED' } });
    expect(audit).toMatchObject({ actorId: manager.id, note: `Applied template "Weekend Bar" to week ${monday} — created 2 shift(s)` });
    expect((await voiceLogs(manager.id)).map((l) => [l.resolvedIntent, l.outcome])).toEqual([['APPLY_ROTA_TEMPLATE', 'EXECUTED']]);
  });

  test('announcements: POST_ANNOUNCEMENT previews the text verbatim and posts exactly that text', async ({ page }) => {
    const { locationId } = await createVenue('announce');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);

    await logIn(page, managerPhone, '/');
    const said = 'Tell everyone the staff meeting moved to 4pm on Thursday please be on time';
    const content = 'The staff meeting moved to 4pm on Thursday — please be on time.';
    await speak(page, said, { intent: 'POST_ANNOUNCEMENT', content, confidence: 0.91, summary: 'Post an announcement to all staff.' });
    const sheet = sheetFor(page, said);
    await expect(sheet.getByText(`“${content}”`, { exact: true })).toBeVisible();
    expect(await prisma.announcement.count({ where: { locationId } })).toBe(0);
    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText('Post an announcement to all staff.');

    const posted = await prisma.announcement.findFirstOrThrow({ where: { locationId } });
    expect(posted).toMatchObject({ authorId: manager.id, body: content });
    expect((await voiceLogs(manager.id)).map((l) => [l.resolvedIntent, l.outcome])).toEqual([['POST_ANNOUNCEMENT', 'EXECUTED']]);
  });

  test('confidence gate: a low-confidence parse offers no Confirm (and no follow-up), and nothing changes', async ({ page }) => {
    const { locationId } = await createVenue('low-confidence');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const request = await prisma.joinRequest.create({ data: { locationId, phone: freshPhone(), fullName: 'Omar Farouk' } });

    await logIn(page, managerPhone, '/');
    const said = 'Approve uh the new guy and also';
    await speak(page, said, {
      intent: 'APPROVE_JOIN', joinRequestId: request.id, confidence: 0.42, hasAdditionalRequest: true,
      summary: "Approve Omar Farouk's request to join.",
    });
    const sheet = sheetFor(page, said);
    await expect(sheet.locator('.eyebrow')).toHaveText("Didn't catch that");
    await expect(
      sheet.getByText(`I understood this as "Approve Omar Farouk's request to join." but wasn't confident enough to act on it without you rephrasing.`),
    ).toBeVisible();
    await expect(sheet.getByRole('button')).toHaveText(['Cancel']);
    await expect(sheet.getByText(FOLLOW_UP)).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toHaveCount(0);

    expect((await prisma.joinRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('PENDING');
    expect(await prisma.user.count({ where: { locationId } })).toBe(1);
    // The raw attempt is what's logged, including the compound flag the UI suppressed.
    const logs = await voiceLogs(manager.id);
    expect(logs.map((l) => [l.resolvedIntent, l.confidence, l.hasAdditionalRequest, l.outcome])).toEqual([['APPROVE_JOIN', 0.42, true, 'LOW_CONFIDENCE']]);
  });

  test('role scoping: a STAFF session cannot execute a manager intent, even when the model returns one', async ({ page }) => {
    const { locationId } = await createVenue('role-scope');
    const staffPhone = freshPhone();
    const staff = await createUser(locationId, 'STAFF', 'E2E Voice Staff', staffPhone);
    const applicantPhone = freshPhone();
    const request = await prisma.joinRequest.create({ data: { locationId, phone: applicantPhone, fullName: 'Omar Farouk' } });

    await logIn(page, staffPhone, '/my-shifts');
    const said = "Approve Omar's request to join";
    await speak(page, said, { intent: 'APPROVE_JOIN', joinRequestId: request.id, confidence: 0.97, summary: "Approve Omar Farouk's request to join." });

    const sheet = sheetFor(page, said);
    await expect(sheet.locator('.eyebrow')).toHaveText('Confirm voice command');

    // A real model couldn't answer this: the staff schema it was given has no manager intents.
    const [, parse] = await expectPipeline([said]);
    expect(intentEnum(parse!)).toEqual(['MARK_AVAILABILITY', 'REQUEST_SWAP', 'QUERY_MY_SCHEDULE', 'UNRECOGNIZED']);

    // /execute is the boundary that holds on its own.
    await sheet.getByRole('button', { name: 'Confirm' }).click();
    const refusal = 'Your role does not permit the "APPROVE_JOIN" action.';
    await expect(page.getByRole('alert').filter({ hasText: refusal })).toBeVisible();
    await expect(page.locator('.success-block')).toHaveCount(0);

    expect(await prisma.joinRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'PENDING', reviewedById: null });
    expect(await prisma.user.findUnique({ where: { phone: applicantPhone } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { locationId, action: 'JOIN_APPROVED' } })).toBe(0);
    const logs = await voiceLogs(staff.id);
    expect(logs.map((l) => [l.resolvedIntent, l.outcome, l.declineReason])).toEqual([['APPROVE_JOIN', 'REJECTED_PERMISSION', refusal]]);
  });
});
