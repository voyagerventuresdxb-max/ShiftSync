import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * @live — the voice step of the golden path against REAL Gemini. Excluded
 * from the regular gate (it spends the per-key free-tier quota and needs
 * GEMINI_API_KEY in the API server's .env):
 *
 *   npm run test:e2e -- golden-path.live --grep @live
 *
 * What is real: /api/voice/parse-intent (Gemini function-calling resolves the
 * spoken sentence to EDIT_SHIFT with the right shift id and times) and
 * /api/voice/execute. What is not: /transcribe — there is no recorded speech
 * fixture yet (Chromium's fake mic is a tone), so the transcript text is
 * supplied at the network layer. Recording one and feeding it with
 * --use-file-for-fake-audio-capture is the follow-up that closes that gap.
 */
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

test.afterAll(async () => {
  await cleanupTestOrgs();
});

test('voice EDIT_SHIFT resolves and executes through real Gemini @live', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 380, height: 822 }, isMobile: true, hasTouch: true, permissions: ['microphone'] });
  try {
    const m = await ctx.newPage();
    const venueName = testVenueName('golden-live');
    await signupNewVenue(m, venueName);
    await continueThroughVenue(m);
    await m.getByRole('button', { name: /Skip for now/ }).click();
    await m.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await m.getByRole('button', { name: /Skip — invite later/ }).click();
    await m.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await m.waitForURL(/\/$/, { timeout: 10000 });

    // Fixture through the real API as the signed-in manager: one staff
    // member with one published shift tomorrow, 17:00–23:00.
    const location = (await prisma.location.findFirst({ where: { name: venueName } }))!;
    const role = (await prisma.role.findFirst({ where: { locationId: location.id, name: 'Bartender' } }))!;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const shiftId = await m.evaluate(
      async ({ roleId, date, locationId }) => {
        const { token } = JSON.parse(localStorage.getItem('shiftsync.session')!);
        const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
        const staff = await (await fetch('/api/staff-directory', { method: 'POST', headers: h, body: JSON.stringify({ fullName: 'Sara Staff' }) })).json();
        const shift = await (await fetch('/api/shifts', { method: 'POST', headers: h, body: JSON.stringify({ roleId, userId: staff.id, date, start: '17:00', end: '23:00' }) })).json();
        const monday = new Date(`${date}T00:00:00Z`);
        monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
        await fetch(`/api/shifts/${locationId}/publish`, { method: 'POST', headers: h, body: JSON.stringify({ weekStart: monday.toISOString().slice(0, 10) }) });
        return shift.shift.id as string;
      },
      { roleId: role.id, date: tomorrow, locationId: location.id },
    );
    expect((await prisma.shift.findUnique({ where: { id: shiftId } }))?.status).toBe('PUBLISHED');

    await m.route('**/api/voice/transcribe', (r) => r.fulfill({ json: { transcript: "Change Sara Staff's shift tomorrow to start at 6pm and finish at 11:30pm" } }));
    await m.goto('/scheduling');
    const parsed = m.waitForResponse((r) => r.url().endsWith('/api/voice/parse-intent'), { timeout: 60_000 });
    await m.getByRole('button', { name: 'Start recording a voice command' }).click();
    await m.getByRole('button', { name: 'Stop recording voice command' }).dispatchEvent('click');
    expect((await parsed).status(), 'parse-intent failed — a 503 means GEMINI_API_KEY is not set for the API server (or its quota is spent)').toBe(200);
    const confirm = m.getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm).toBeVisible();
    const executed = m.waitForResponse((r) => r.url().endsWith('/api/voice/execute'));
    await confirm.click();
    const res = await executed;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { result: { id: string } };
    expect(body.result.id).toBe(shiftId);

    const edited = (await prisma.shift.findUnique({ where: { id: shiftId } }))!;
    // 18:00–23:30 in Dubai (UTC+4).
    expect([edited.startTime.toISOString(), edited.endTime.toISOString()]).toEqual([`${tomorrow}T14:00:00.000Z`, `${tomorrow}T19:30:00.000Z`]);
  } finally {
    await ctx.close().catch(() => {});
  }
});
