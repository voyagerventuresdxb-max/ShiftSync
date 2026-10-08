import { mkdirSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import type { SystemRole } from '@prisma/client';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';
import { geminiCalls, resetFakeGemini, scriptIntent, scriptUtterance, type GeminiCall } from './fakeGemini';

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
  // The first recording per person on a device asks first (VoiceConsentSheet).
  const useVoice = page.getByRole('button', { name: 'Use voice' });
  await expect(stop.or(useVoice)).toBeVisible();
  if (await useVoice.isVisible()) await useVoice.click();
  await expect(stop).toBeVisible();
  await page.waitForTimeout(700);
  // While listening the button "breathes" (an endless scale animation), so it never passes Playwright's stability check.
  await stop.click({ force: true });
}

/** The voice sheet: the one dialog that shows what was heard. */
function voiceSheet(page: Page) {
  return page.getByRole('dialog').filter({ hasText: 'I heard' });
}

/** The sheet for this transcript, while it shows what was heard as text (not in the edit box). */
function sheetFor(page: Page, transcript: string) {
  return voiceSheet(page).filter({ hasText: `“${transcript}”` });
}

/** Phone-sized screenshots of the sheet, made-up data only (run 13 review). */
const SCREENS = 'C:/dev/_autonomous-run-artifacts/run13-screens/voice';

async function phone(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  // Reduced motion: the sheet must not animate at all (and screenshots are then stable).
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (process.platform !== 'win32') return;
  mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: `${SCREENS}/${name}.png` });
}

/** Every control in the sheet is at least 44x44 CSS px on its own (no reliance on a hit-area expansion), and nothing in it animates under reduced motion. */
async function expectPhoneFriendly(sheet: Locator): Promise<void> {
  const boxes = await sheet.locator('button, a[href], textarea').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { label: (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );
  expect(boxes.length).toBeGreaterThan(0);
  expect(boxes.filter((b) => b.w < 44 || b.h < 44)).toEqual([]);
  // CSS animations only (the sheet's rise): a hover's colour transition is not motion.
  expect(await sheet.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => 'animationName' in a).length)).toBe(0);
}

async function voiceLogs(actorId: string) {
  return prisma.voiceInteractionLog.findMany({ where: { actorId }, orderBy: { createdAt: 'asc' } });
}

/** The parse call's `tool` enum — what the model was structurally allowed to answer for this caller. */
function intentEnum(call: GeminiCall): unknown {
  const config = call.body.generationConfig as { responseSchema?: { properties?: { tool?: { enum?: unknown } } } } | undefined;
  return config?.responseSchema?.properties?.tool?.enum;
}

/** Every tool a staff caller's model may answer with: their own changes, the reads, a decline, or "not understood". */
const STAFF_TOOLS = ['MARK_AVAILABILITY', 'REQUEST_SWAP', 'REQUEST_TIME_OFF', 'QUERY_MY_SCHEDULE', 'WHO_IS_WORKING', 'WHO_IN_SECTION', 'PENDING_REQUESTS', 'RECENT_ANNOUNCEMENTS', 'DECLINED', 'UNRECOGNIZED'];

/** "Sat 17 Oct": how the server's own sentences name a day. */
const shortDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** What the server answers for "what's my schedule?" when there is nothing in the next 14 days. */
const NO_SHIFTS = 'You have no shifts in the next 14 days.';

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
    await phone(page);
    const { locationId, roleId } = await createVenue('compound');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const layla = await createUser(locationId, 'STAFF', 'Layla Haddad');
    const saturday = addDays(nextMonday(), 5);

    await logIn(page, managerPhone, '/');

    const first = 'Create a bartender shift for Layla on Saturday 6pm to 2am and give her a shoutout for covering last night';
    // The model passes the words as heard; the server finds the role and person and writes the sentence.
    const createSummary = `Create a Bartender shift for Layla Haddad, ${shortDay(saturday)} 18:00–02:00.`;
    await speak(page, first, {
      tool: 'CREATE_SHIFT', args: { role: 'bartender', person: 'Layla', day: saturday, start: '6pm', end: '2am' },
      confidence: 0.93, hasAdditionalRequest: true, summary: 'Create a bartender shift for Layla on Saturday.',
    });

    // Before executing: the plain confirm view for the primary intent, no follow-up copy yet.
    const sheet = sheetFor(page, first);
    await expect(sheet.locator('.eyebrow')).toHaveText('New shift');
    await expect(sheet.getByText(createSummary, { exact: true })).toBeVisible();
    await expect(sheet.getByText(FOLLOW_UP)).toHaveCount(0);
    // The rota line: person, role, day and time, as a draft.
    await expect(sheet.getByText('Layla Haddad', { exact: true })).toBeVisible();
    await expect(sheet.getByText(/^Bartender · Saturday \d{1,2} \w+ \d{4}, 18:00 – 02:00 \(ends Sunday\)$/)).toBeVisible();
    await expectPhoneFriendly(sheet);
    await screenshot(page, '06-new-shift-preview');
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
      tool: 'POST_SHOUTOUT', args: { person: 'Layla', message: note },
      confidence: 0.9, hasAdditionalRequest: false, summary: 'Post a shoutout for Layla Haddad.',
    });
    const sheet2 = sheetFor(page, second);
    await expect(sheet2.locator('.eyebrow')).toHaveText('Shout-out');
    await expect(sheet2.getByText(note, { exact: true })).toBeVisible();
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
    await speak(page, said, { tool: 'MARK_AVAILABILITY', args: { day: monday, availability: 'UNAVAILABLE' }, confidence: 0.95, summary });
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
    // The answer is the server's, from the caller's own shifts: the model only picked the question.
    await speak(page, asked, { tool: 'QUERY_MY_SCHEDULE', args: {}, confidence: 0.9, summary: 'What is my schedule this week?' });
    const answer = sheetFor(page, asked);
    await expect(answer.getByText(NO_SHIFTS, { exact: true }).first()).toBeVisible();
    await expect(answer.getByRole('button')).toHaveText([/^(Got it|Done)$/]);
    await answer.getByRole('button', { name: /^(Got it|Done)$/ }).click();
    await expect(answer).toHaveCount(0);

    const logs = await voiceLogs(staff.id);
    expect(logs.map((l) => [l.resolvedIntent, l.outcome])).toEqual([
      ['MARK_AVAILABILITY', 'EXECUTED'],
      ['QUERY_MY_SCHEDULE', 'ANSWERED'],
    ]);
    const calls = await expectPipeline([said, asked]);
    expect(intentEnum(calls[1]!)).toEqual(STAFF_TOOLS);
  });

  test('consent: the first tap explains where the audio goes; "Not now" records and sends nothing; it is asked once', async ({ page }) => {
    const { locationId } = await createVenue('consent');
    const staffPhone = freshPhone();
    await createUser(locationId, 'STAFF', 'E2E Voice Consent', staffPhone);
    await logIn(page, staffPhone, '/my-shifts');

    const mic = page.getByRole('button', { name: 'Start recording a voice command' });
    await mic.click();
    const notice = page.getByRole('dialog', { name: 'Before you use voice' });
    await expect(notice).toContainText("Google's Gemini AI service");
    await expect(notice).toContainText("ShiftSync doesn't keep the recording");
    await notice.getByRole('button', { name: 'Not now' }).click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop recording voice command' })).toHaveCount(0);
    expect(await geminiCalls()).toEqual([]);

    const asked = "What's my schedule this week?";
    await speak(page, asked, { tool: 'QUERY_MY_SCHEDULE', args: {}, confidence: 0.9, summary: 'What is my schedule this week?' });
    await sheetFor(page, asked).getByRole('button', { name: /^(Got it|Done)$/ }).click();

    await scriptUtterance(asked, { tool: 'QUERY_MY_SCHEDULE', args: {}, confidence: 0.9, summary: 'What is my schedule this week?' });
    await mic.click();
    await expect(page.getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
    await expect(notice).toHaveCount(0);
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: 'Stop recording voice command' }).click({ force: true });
    await expect(sheetFor(page, asked)).toBeVisible();
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
    await speak(page, said, { tool: 'APPROVE_JOIN', args: { applicant: 'Omar' }, confidence: 0.9, summary });
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
    await speak(page, said, { tool: 'PUBLISH_ROTA', args: { week: monday }, confidence: 0.9, summary: 'Publish the rota for next week.' });
    // Only what this publish changes (three draft shifts) and who it notifies (two people).
    const preview = `This will publish 3 new or changed shifts for the week of ${shortDay(monday)} and notify 2 people — confirm?`;
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
    await prisma.rotaTemplate.create({
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
    await speak(page, said, { tool: 'APPLY_ROTA_TEMPLATE', args: { template: 'weekend bar', week: monday }, confidence: 0.88, summary: 'Apply the weekend bar template.' });
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
    await phone(page);
    const { locationId } = await createVenue('announce');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);

    await logIn(page, managerPhone, '/');
    const said = 'Tell everyone the staff meeting moved to 4pm on Thursday please be on time';
    const content = 'The staff meeting moved to 4pm on Thursday — please be on time.';
    await speak(page, said, { tool: 'POST_ANNOUNCEMENT', args: { message: content }, confidence: 0.91, summary: 'Post an announcement to all staff.' });
    const sheet = sheetFor(page, said);
    // The preview is the board's own announcement card: the text verbatim, under the poster's name.
    await expect(sheet.getByText('How it will look')).toBeVisible();
    await expect(sheet.getByText(content, { exact: true })).toBeVisible();
    await expect(sheet.getByText(/^E2E Voice Manager · /)).toBeVisible();
    await screenshot(page, '07-announcement-preview');
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
    await speak(page, said, { tool: 'APPROVE_JOIN', args: {}, confidence: 0.42, hasAdditionalRequest: true, summary: "Approve Omar Farouk's request to join." });
    const sheet = voiceSheet(page);
    await expect(sheet.locator('.eyebrow')).toHaveText("Didn't catch that");
    await expect(sheet.getByRole('heading', { name: "I'm not sure I got that right." })).toBeVisible();
    await expect(
      sheet.getByText(`It sounded like "Approve Omar Farouk's request to join", but I'd rather check than guess. Say it again, or fix what I heard and try again.`),
    ).toBeVisible();
    // What was heard is open for editing; there is nothing to confirm.
    await expect(sheet.getByLabel(/I heard/)).toHaveValue(said);
    await expect(sheet.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(sheet.getByText(FOLLOW_UP)).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toHaveCount(0);

    expect((await prisma.joinRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('PENDING');
    expect(await prisma.user.count({ where: { locationId } })).toBe(1);
    // The raw attempt is what's logged, including the compound flag the UI suppressed.
    const logs = await voiceLogs(manager.id);
    expect(logs.map((l) => [l.resolvedIntent, l.confidence, l.hasAdditionalRequest, l.outcome])).toEqual([['APPROVE_JOIN', 0.42, true, 'LOW_CONFIDENCE']]);
  });

  test('which did you mean: approve or decline are offered as choices; a choice opens its own Confirm, and only that runs', async ({ page }) => {
    await phone(page);
    const { locationId } = await createVenue('choices');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const request = await prisma.joinRequest.create({ data: { locationId, phone: freshPhone(), fullName: 'Omar Farouk' } });

    await logIn(page, managerPhone, '/');
    const said = 'Omar, the new guy, uh';
    const approve = "Approve Omar Farouk's request to join.";
    const decline = "Decline Omar Farouk's request to join.";
    await speak(page, said, {
      tool: 'APPROVE_JOIN', args: { applicant: 'Omar' }, confidence: 0.45, summary: approve,
      alternatives: [{ tool: 'DECLINE_JOIN', args: { applicant: 'Omar' }, confidence: 0.4, summary: decline }],
    });
    const sheet = sheetFor(page, said);
    await expect(sheet.locator('.eyebrow')).toHaveText('Choose one');
    await expect(sheet.getByRole('heading', { name: 'Which did you mean?' })).toBeVisible();
    await expect(sheet.getByRole('button')).toHaveText([approve, decline, 'Edit', 'Cancel']);
    await expectPhoneFriendly(sheet);
    await screenshot(page, '08-which-did-you-mean');

    // Choosing only shows that reading for its own Confirm: nothing has changed yet.
    await sheet.getByRole('button', { name: decline }).click();
    await expect(sheet.locator('.eyebrow')).toHaveText('Join request');
    await expect(sheet.getByRole('heading', { name: decline })).toBeVisible();
    await expect(sheet.getByText('Omar Farouk', { exact: true })).toBeVisible();
    expect((await prisma.joinRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('PENDING');

    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText(decline);
    expect((await prisma.joinRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('DECLINED');
    expect(await prisma.user.count({ where: { locationId } })).toBe(1);
    // The log row names what was confirmed, with the model's low confidence kept.
    expect((await voiceLogs(manager.id)).map((l) => [l.resolvedIntent, l.confidence, l.outcome])).toEqual([['DECLINE_JOIN', 0.45, 'EXECUTED']]);
  });

  test('role scoping: a STAFF session cannot execute a manager intent, even when the model returns one', async ({ page }) => {
    const { locationId } = await createVenue('role-scope');
    const staffPhone = freshPhone();
    const staff = await createUser(locationId, 'STAFF', 'E2E Voice Staff', staffPhone);
    const applicantPhone = freshPhone();
    const request = await prisma.joinRequest.create({ data: { locationId, phone: applicantPhone, fullName: 'Omar Farouk' } });

    await logIn(page, staffPhone, '/my-shifts');
    const said = "Approve Omar's request to join";
    await speak(page, said, { tool: 'APPROVE_JOIN', args: { applicant: 'Omar' }, confidence: 0.97, summary: "Approve Omar Farouk's request to join." });

    // The role is checked BEFORE any confirm sheet: a staff member is told
    // plainly and never sees a "Confirm" for a manager action.
    await expect(page.getByRole('alert').filter({ hasText: 'That command needs a manager or owner account.' })).toBeVisible();
    await expect(sheetFor(page, said)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirm' })).toHaveCount(0);

    // A real model couldn't answer this: the staff schema it was given has no manager tools.
    const [, parse] = await expectPipeline([said]);
    expect(intentEnum(parse!)).toEqual(STAFF_TOOLS);

    // Nothing reached /execute, nothing changed.
    expect(await prisma.joinRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'PENDING', reviewedById: null });
    expect(await prisma.user.findUnique({ where: { phone: applicantPhone } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { locationId, action: 'JOIN_APPROVED' } })).toBe(0);
    const logs = await voiceLogs(staff.id);
    // The parse step refused it too (role check), so the log says so rather than "pending confirmation".
    expect(logs.map((l) => [l.resolvedIntent, l.outcome])).toEqual([['APPROVE_JOIN', 'REJECTED_PERMISSION']]);

    // /execute is the boundary that holds on its own, even for a hand-crafted request.
    const direct = await page.request.post('/api/voice/execute', {
      headers: { Authorization: `Bearer ${JSON.parse((await page.evaluate(() => localStorage.getItem('shiftsync.session'))) ?? '{}').token}` },
      data: { transcript: said, intent: { intent: 'APPROVE_JOIN', joinRequestId: request.id, confidence: 0.97, summary: 'x' } },
    });
    expect(direct.status()).toBe(403);
    expect(await prisma.joinRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'PENDING', reviewedById: null });
  });

  test('shout-out: the name said is looked up, the preview is the board card, and Confirm posts exactly one', async ({ page }) => {
    await phone(page);
    const { locationId } = await createVenue('shoutout');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const layla = await createUser(locationId, 'STAFF', 'Layla Nasser');
    await createUser(locationId, 'STAFF', 'Omar Haddad');

    await logIn(page, managerPhone, '/');
    const said = 'Give Layla a shout-out saying great job';
    // The model gives the name as said (it is never given ids): the server finds her in this venue.
    await speak(page, said, { tool: 'POST_SHOUTOUT', args: { person: 'Layla', message: 'Great job' }, confidence: 0.95, summary: 'Give Layla a shout-out with this note.' });
    const sheet = sheetFor(page, said);
    await expect(sheet.locator('.eyebrow')).toHaveText('Shout-out');
    await expect(sheet.getByText('How it will look')).toBeVisible();
    // The board's own shout-out card: full name, the note, who and when.
    await expect(sheet.getByText('Layla Nasser', { exact: true })).toBeVisible();
    await expect(sheet.getByText('Great job', { exact: true })).toBeVisible();
    await expect(sheet.getByText('E2E Voice Manager · just now', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button')).toHaveText(['Confirm', 'Edit', 'Cancel']);
    await expectPhoneFriendly(sheet);
    await screenshot(page, '01-shoutout-preview');
    expect(await prisma.shoutout.count({ where: { locationId } })).toBe(0);

    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText('Give Layla a shout-out with this note.');
    const posted = await prisma.shoutout.findMany({ where: { locationId } });
    expect(posted.map((s) => [s.employeeId, s.authorId, s.note])).toEqual([[layla.id, manager.id, 'Great job']]);
  });

  test("shout-out to someone who isn't on the team: a plain message naming them, a way to People, and nothing changes", async ({ page }) => {
    await phone(page);
    const { locationId } = await createVenue('missing');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    await createUser(locationId, 'STAFF', 'Layla Nasser');

    await logIn(page, managerPhone, '/');
    const said = 'Give Rana a shout-out saying great job';
    await speak(page, said, { tool: 'POST_SHOUTOUT', args: { person: 'Rana', message: 'Great job' }, confidence: 0.9, summary: 'Give Rana a shout-out.' });
    const sheet = voiceSheet(page);
    await expect(sheet.locator('.eyebrow')).toHaveText('Not on your team');
    await expect(sheet.getByRole('heading', { name: "I couldn't find Rana on your team." })).toBeVisible();
    await expect(sheet.getByText('If Rana is new, add them in People first, then try again.')).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Open People' })).toBeVisible();
    await expect(sheet.getByLabel(/I heard/)).toHaveValue(said);
    await expect(sheet.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await expect(sheet).not.toContainText(/supported command|intent/i);
    await expectPhoneFriendly(sheet);
    await screenshot(page, '02-shoutout-missing-person');

    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toHaveCount(0);
    expect(await prisma.shoutout.count({ where: { locationId } })).toBe(0);
    // Logged by kind and count only.
    const logs = await voiceLogs(manager.id);
    expect(logs.map((l) => [l.resolvedIntent, l.outcome, l.declineReason])).toEqual([['POST_SHOUTOUT', 'REJECTED_VALIDATION', 'person_missing:0']]);
  });

  test('a first name two people share: "Which Karim?", choosing one previews it, Cancel changes nothing', async ({ page }) => {
    await phone(page);
    const { locationId } = await createVenue('which');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    await createUser(locationId, 'STAFF', 'Karim Saleh');
    await createUser(locationId, 'STAFF', 'Karim Aziz');

    await logIn(page, managerPhone, '/');
    const said = 'Give Karim a shout-out saying great job';
    // Seen live: a confident model. The name as heard fits two people, so the app asks.
    await speak(page, said, { tool: 'POST_SHOUTOUT', args: { person: 'Karim', message: 'Great job' }, confidence: 0.9, summary: 'Give Karim a shout-out.' });
    const sheet = sheetFor(page, said);
    await expect(sheet.locator('.eyebrow')).toHaveText('Which person?');
    await expect(sheet.getByRole('heading', { name: 'Which Karim did you mean?' })).toBeVisible();
    const choices = sheet.getByRole('group', { name: 'People to choose from' }).getByRole('button');
    await expect(choices).toHaveText([/Karim Aziz/, /Karim Saleh/]);
    await expect(sheet.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await expectPhoneFriendly(sheet);
    await screenshot(page, '03-which-karim');

    // A choice only previews that reading; nothing has changed.
    await sheet.getByRole('button', { name: /Karim Aziz/ }).click();
    await expect(sheet.locator('.eyebrow')).toHaveText('Shout-out');
    await expect(sheet.getByRole('heading', { name: 'Give Karim Aziz a shout-out.' })).toBeVisible();
    await expect(sheet.getByText('Karim Aziz', { exact: true })).toBeVisible();
    await expect(sheet.getByText('Great job', { exact: true })).toBeVisible();
    await expectPhoneFriendly(sheet);
    await screenshot(page, '04-which-karim-chosen');
    expect(await prisma.shoutout.count({ where: { locationId } })).toBe(0);

    // Back to the list, pick again, then Cancel: still nothing.
    await sheet.getByRole('button', { name: 'Other choices' }).click();
    await expect(choices).toHaveCount(2);
    await sheet.getByRole('button', { name: /Karim Aziz/ }).click();
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(voiceSheet(page)).toHaveCount(0);
    expect(await prisma.shoutout.count({ where: { locationId } })).toBe(0);
    const logs = await voiceLogs(manager.id);
    expect(logs.map((l) => [l.resolvedIntent, l.outcome, l.declineReason])).toEqual([['POST_SHOUTOUT', 'REJECTED_VALIDATION', 'person_ambiguous:2']]);
  });

  test('edit what was heard: "Try again" re-reads the edited words (no new recording), and only the new reading is confirmed', async ({ page }) => {
    await phone(page);
    const { locationId } = await createVenue('edit');
    const managerPhone = freshPhone();
    const manager = await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    const layla = await createUser(locationId, 'STAFF', 'Layla Nasser');

    await logIn(page, managerPhone, '/');
    const misheard = 'Give later a shout out saying great job';
    await speak(page, misheard, {
      tool: 'UNRECOGNIZED', args: {}, summary: "I didn't catch who the shout-out is for.", unrecognizedReason: 'Say their name, for example "Give Sam a shout-out".',
    });
    const sheet = voiceSheet(page);
    await expect(sheet.locator('.eyebrow')).toHaveText("Didn't catch that");
    await expect(sheet.getByRole('heading', { name: "I didn't catch who the shout-out is for." })).toBeVisible();
    const heard = sheet.getByLabel(/I heard/);
    await expect(heard).toHaveValue(misheard);
    await expectPhoneFriendly(sheet);
    await screenshot(page, '05-not-understood-edit');

    const fixed = 'Give Layla a shout-out saying great job';
    await heard.fill(fixed);
    await scriptIntent({ tool: 'POST_SHOUTOUT', args: { person: 'Layla', message: 'Great job' }, confidence: 0.95, summary: 'Give Layla Nasser a shout-out with this note.' });
    await sheet.getByRole('button', { name: 'Try again' }).click();
    const again = sheetFor(page, fixed);
    await expect(again.locator('.eyebrow')).toHaveText('Shout-out');
    await expect(again.getByText('Layla Nasser', { exact: true })).toBeVisible();
    // One recording, two reads: the second read was the edited text, and nothing was transcribed again.
    const calls = await geminiCalls();
    expect(calls.map((c) => c.kind)).toEqual(['transcribe', 'parse', 'parse']);
    expect(calls[2]!.body.contents?.[0]?.parts?.[0]?.text).toBe(fixed);

    // Edit from the preview opens the box again; Back returns to the same preview.
    await again.getByRole('button', { name: 'Edit' }).click();
    await expect(voiceSheet(page).getByLabel(/I heard/)).toHaveValue(fixed);
    await expect(voiceSheet(page).getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await voiceSheet(page).getByRole('button', { name: 'Back' }).click();
    await again.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText('Give Layla Nasser a shout-out with this note.');
    const posted = await prisma.shoutout.findMany({ where: { locationId } });
    expect(posted.map((s) => [s.employeeId, s.note])).toEqual([[layla.id, 'Great job']]);
    const logs = await voiceLogs(manager.id);
    expect(logs.map((l) => [l.transcript, l.outcome])).toEqual([
      [misheard, 'UNRECOGNIZED'],
      [fixed, 'EXECUTED'],
    ]);
  });

  test('a command missing a part (seen live): "Almost there" asks for exactly that part; fixing the words and trying again gives the preview', async ({ page }) => {
    await phone(page);
    const { locationId } = await createVenue('incomplete');
    const managerPhone = freshPhone();
    await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    await createUser(locationId, 'STAFF', 'Alex Morgan');
    const friday = addDays(nextMonday(), 4);

    await logIn(page, managerPhone, '/');
    const said = 'Create a bartender shift for Alex on Friday from 6 p.m.';
    // The live answer's shape: no end, no role, no person.
    await speak(page, said, { tool: 'CREATE_SHIFT', args: { day: friday, start: '18:00' }, summary: 'Create a Bartender shift for Alex Morgan on Friday.', confidence: 0.95 });
    const sheet = voiceSheet(page);
    await expect(sheet.locator('.eyebrow')).toHaveText('Almost there');
    const day = new Date(`${friday}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    await expect(sheet.getByRole('heading', { name: `I've got a new shift on ${day} from 18:00 — what time does it end, and which role?` })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await expectPhoneFriendly(sheet);
    await screenshot(page, '09-almost-there');

    const fixed = 'Create a bartender shift for Alex on Friday from 6 p.m. to 2 a.m.';
    await sheet.getByLabel(/I heard/).fill(fixed);
    await scriptIntent({
      tool: 'CREATE_SHIFT', args: { role: 'bartender', person: 'Alex', day: friday, start: '6 p.m.', end: '2 a.m.' },
      confidence: 0.95, summary: 'Create a bartender shift for Alex on Friday.',
    });
    await sheet.getByRole('button', { name: 'Try again' }).click();
    const again = sheetFor(page, fixed);
    await expect(again.locator('.eyebrow')).toHaveText('New shift');
    await expect(again.getByText('Alex Morgan', { exact: true })).toBeVisible();
    expect(await prisma.shift.count({ where: { locationId } })).toBe(0);
    await again.getByRole('button', { name: 'Cancel' }).click();
    expect(await prisma.shift.count({ where: { locationId } })).toBe(0);
  });

  test('a close misspelling with a part missing: the near name is offered, and tapping it reads the words again with that name', async ({ page }) => {
    await phone(page);
    const { locationId } = await createVenue('alix');
    const managerPhone = freshPhone();
    await createUser(locationId, 'MANAGER', 'E2E Voice Manager', managerPhone);
    await createUser(locationId, 'STAFF', 'Alex Morgan');

    await logIn(page, managerPhone, '/');
    const said = 'Give Alek a shout-out.';
    await speak(page, said, { tool: 'POST_SHOUTOUT', args: { person: 'Alek' }, confidence: 0.9, summary: 'Give Alek a shout-out.' });
    const sheet = voiceSheet(page);
    await expect(sheet.getByRole('heading', { name: "I couldn't find Alek on your team." })).toBeVisible();
    await expect(sheet.getByText(/^Did you mean Alex Morgan\? If Alek is new/)).toBeVisible();
    const names = sheet.getByRole('group', { name: 'Names to try instead' }).getByRole('button');
    await expect(names).toHaveText([/Alex Morgan/]);
    await expectPhoneFriendly(sheet);
    await screenshot(page, '10-did-you-mean-name');

    await scriptIntent({ tool: 'POST_SHOUTOUT', args: { person: 'Alex Morgan' }, confidence: 0.9, summary: 'Give Alex Morgan a shout-out.' });
    await names.first().click();
    await expect(sheet.locator('.eyebrow')).toHaveText('Almost there');
    await expect(sheet.getByRole('heading', { name: "I've got a shout-out for Alex Morgan — what should it say?" })).toBeVisible();
    await expect(sheet.getByLabel(/I heard/)).toHaveValue('Give Alex Morgan a shout-out.');
    const calls = await geminiCalls();
    expect(calls.map((c) => c.kind)).toEqual(['transcribe', 'parse', 'parse']);
    expect(calls[2]!.body.contents?.[0]?.parts?.[0]?.text).toBe('Give Alex Morgan a shout-out.');
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    expect(await prisma.shoutout.count({ where: { locationId } })).toBe(0);
  });
});
