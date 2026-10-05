import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, skipOtpResendWait, testVenueName } from './helpers';

/**
 * Calendar liveness under a FAKED browser clock (page.clock) in two viewer
 * timezones. The venue is Asia/Dubai; the viewer is in Dubai or Los Angeles.
 *
 * Instants (all expressed in Dubai, UTC+4):
 *   2026-10-03 10:00  Saturday        → week Mon 28 Sep – Sun 4 Oct, "tomorrow" = Sun 4 Oct
 *   2026-10-31 23:30  Saturday        → week Mon 26 Oct – Sun 1 Nov, "tomorrow" = Sun 1 Nov (month rollover)
 *   2026-12-31 23:30  Thursday        → week Mon 28 Dec – Sun 3 Jan 2027, "tomorrow" = Fri 1 Jan 2027 (year rollover)
 *
 * What is asserted: the Scheduling week is the one containing the device's
 * "now"; prev/next moves across the month and year boundary with the right
 * label and `?week=`; a shift added on "tomorrow" in the Shift Editor is
 * stored on exactly that calendar day with venue-time instants; My Shifts
 * shows venue wall-clock times; and the swap-request lock state is the same
 * for both viewers (it comes from the server, not the device clock).
 */
const DUBAI = 'Asia/Dubai';
const LA = 'America/Los_Angeles';

interface Scenario {
  name: string;
  /** The faked instant, as an ISO string with the Dubai offset. */
  now: string;
  weekStart: string;
  weekLabel: RegExp;
  nextWeekStart: string;
  nextWeekLabel: RegExp;
  /** "Tomorrow" on the device clock, per viewer timezone. */
  tomorrow: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  {
    name: '2026-10-03 10:00 Dubai (Saturday)',
    now: '2026-10-03T10:00:00+04:00',
    weekStart: '2026-09-28',
    weekLabel: /^Mon 28 Sept? – Sun 4 Oct 2026$/,
    nextWeekStart: '2026-10-05',
    nextWeekLabel: /^Mon 5 Oct – Sun 11 Oct 2026$/,
    // 06:00Z: Oct 3 in Dubai, still Oct 2 (23:00) in Los Angeles.
    tomorrow: { [DUBAI]: '2026-10-04', [LA]: '2026-10-03' },
  },
  {
    name: '2026-10-31 23:30 Dubai (Saturday, month rollover)',
    now: '2026-10-31T23:30:00+04:00',
    weekStart: '2026-10-26',
    weekLabel: /^Mon 26 Oct – Sun 1 Nov 2026$/,
    nextWeekStart: '2026-11-02',
    nextWeekLabel: /^Mon 2 Nov – Sun 8 Nov 2026$/,
    // 19:30Z: Oct 31 in both Dubai and Los Angeles (12:30).
    tomorrow: { [DUBAI]: '2026-11-01', [LA]: '2026-11-01' },
  },
  {
    name: '2026-12-31 23:30 Dubai (Thursday, year rollover)',
    now: '2026-12-31T23:30:00+04:00',
    weekStart: '2026-12-28',
    weekLabel: /^Mon 28 Dec 2026 – Sun 3 Jan 2027$/,
    nextWeekStart: '2027-01-04',
    nextWeekLabel: /^Mon 4 Jan – Sun 10 Jan 2027$/,
    tomorrow: { [DUBAI]: '2027-01-01', [LA]: '2027-01-01' },
  },
];

const usedPhones: string[] = [];

async function createVenue() {
  const org = await prisma.organization.create({ data: { name: testVenueName('calendar') } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name, timezone: DUBAI, emirate: 'Dubai', venueType: 'Fine Dining' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Bartender' } });
  const ownerPhone = nextEchoPhone();
  usedPhones.push(ownerPhone);
  const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'Calendar Owner', phone: ownerPhone, roleId: role.id } });
  const staffPhone = nextEchoPhone();
  usedPhones.push(staffPhone);
  const staff = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'Calendar Staff', phone: staffPhone, roleId: role.id } });
  return { location, role, owner, ownerPhone, staff, staffPhone };
}

async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

async function logIn(page: Page, phone: string): Promise<void> {
  await open(page, '/login');
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
}

/** A context whose device timezone is `timezoneId`; the clock is faked by `jumpClockTo` after sign-in. */
async function viewer(browser: Browser, timezoneId: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ timezoneId });
  const page = await context.newPage();
  return { context, page };
}

/**
 * Fakes the device clock at `now` for every page load from here on. Signing in
 * happened under the real clock, so the 30-day session (server row and the
 * stored copy) is extended past the faked instant first — a real device whose
 * clock jumped three months would rightly be signed out, which is not what
 * this test is about.
 */
async function jumpClockTo(page: Page, userId: string, now: string): Promise<void> {
  const expiresAt = new Date(new Date(now).getTime() + 30 * 86_400_000);
  await prisma.session.updateMany({ where: { userId }, data: { expiresAt } });
  await page.evaluate((iso) => {
    const raw = localStorage.getItem('shiftsync.session');
    if (raw) localStorage.setItem('shiftsync.session', JSON.stringify({ ...JSON.parse(raw), expiresAt: iso }));
  }, expiresAt.toISOString());
  await page.clock.install({ time: new Date(now) });
}

test.describe('calendar liveness — faked clock, Dubai and Los Angeles viewers', () => {
  test.afterEach(async () => {
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  for (const scenario of SCENARIOS) {
    for (const tz of [DUBAI, LA]) {
      test(`${scenario.name}, viewed from ${tz}: this week, next week across the boundary, a shift on tomorrow`, async ({ browser }) => {
        const { ownerPhone, location, owner } = await createVenue();
        const { context, page } = await viewer(browser, tz);
        try {
          await logIn(page, ownerPhone);
          await page.waitForURL((url) => url.pathname === '/');
          await jumpClockTo(page, owner.id, scenario.now);

          // --- Scheduling shows the week containing the device's "now".
          await page.goto('/scheduling');
          await expect.poll(() => new URL(page.url()).searchParams.get('week')).toBe(scenario.weekStart);
          const builderToggle = page.getByRole('button', { name: /Weekly rota builder/ });
          if ((await builderToggle.getAttribute('aria-expanded')) !== 'true') await builderToggle.click();
          await expect(page.getByTestId('rota-week-label')).toHaveText(scenario.weekLabel);

          // --- Next week crosses the month/year boundary with the right label and URL.
          await page.getByRole('button', { name: 'Next week' }).click();
          await expect(page.getByTestId('rota-week-label')).toHaveText(scenario.nextWeekLabel);
          await expect.poll(() => new URL(page.url()).searchParams.get('week')).toBe(scenario.nextWeekStart);
          await page.getByRole('button', { name: 'Previous week' }).click();
          await expect(page.getByTestId('rota-week-label')).toHaveText(scenario.weekLabel);

          // --- A non-Monday ?week= is snapped to its Monday.
          const tomorrow = scenario.tomorrow[tz]!;
          await page.goto(`/scheduling?week=${tomorrow}`);
          await expect.poll(() => new URL(page.url()).searchParams.get('week')).toBe(mondayOf(tomorrow));

          // --- Rota builder: add a shift on "tomorrow"; it is stored on exactly that venue day.
          await page.goto(`/scheduling?week=${scenario.weekStart}`);
          const toggle = page.getByRole('button', { name: /Weekly rota builder/ });
          if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
          await page.getByRole('button', { name: `Add shift on ${tomorrow}` }).first().click();
          await expect(page.getByRole('heading', { name: 'New shift' })).toBeVisible();
          await page.locator('select').filter({ hasText: 'Select a role…' }).selectOption({ label: 'Bartender' });
          await page.locator('input[type=time]').nth(0).fill('10:00');
          await page.locator('input[type=time]').nth(1).fill('15:00');
          const created = page.waitForResponse((r) => r.url().endsWith('/api/shifts') && r.request().method() === 'POST');
          await page.getByRole('button', { name: 'Add shift', exact: true }).click();
          expect((await created).status()).toBe(201);
          await expect(page.getByRole('heading', { name: 'New shift' })).toHaveCount(0);
          const row = await prisma.shift.findFirst({ where: { locationId: location.id } });
          expect(row?.date.toISOString().slice(0, 10)).toBe(tomorrow);
          // 10:00 at the Dubai venue is 06:00Z, whatever the viewer's zone.
          expect(row?.startTime.toISOString()).toBe(`${tomorrow}T06:00:00.000Z`);
        } finally {
          await context.close();
        }
      });
    }
  }

  test('My Shifts shows venue wall-clock times and the swap lock is identical for a Dubai and a Los Angeles viewer', async ({ browser }) => {
    const { location, role, ownerPhone, staffPhone, staff } = await createVenue();
    const other = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'Other Staff', roleId: role.id } });
    // A 19:00–23:00 Dubai shift for the staffer "tomorrow" in Dubai, under the real clock.
    const dubaiTomorrow = new Date(Date.now() + 4 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
    const shift = await prisma.shift.create({
      data: {
        locationId: location.id,
        roleId: role.id,
        userId: staff.id,
        date: new Date(`${dubaiTomorrow}T00:00:00.000Z`),
        startTime: new Date(`${dubaiTomorrow}T15:00:00.000Z`),
        endTime: new Date(`${dubaiTomorrow}T19:00:00.000Z`),
        status: 'PUBLISHED',
      },
    });
    // One pending request whose shift was already handed to someone else (locked), one still open.
    const takenShift = await prisma.shift.create({
      data: { locationId: location.id, roleId: role.id, userId: other.id, date: shift.date, startTime: shift.startTime, endTime: shift.endTime, status: 'PUBLISHED' },
    });
    const closeAt = new Date(Date.now() + 2 * 86_400_000);
    await prisma.shiftSwapRequest.create({
      data: { shiftId: takenShift.id, requestedById: staff.id, targetUserId: other.id, type: 'COVER', status: 'PENDING', expiresAt: closeAt, reason: 'locked one' },
    });
    await prisma.shiftSwapRequest.create({
      data: { shiftId: shift.id, requestedById: staff.id, targetUserId: other.id, type: 'COVER', status: 'PENDING', expiresAt: closeAt, reason: 'open one' },
    });

    for (const tz of [DUBAI, LA]) {
      const staffContext = await browser.newContext({ timezoneId: tz });
      const ownerContext = await browser.newContext({ timezoneId: tz });
      try {
        await skipOtpResendWait(staffPhone);
        const staffPage = await staffContext.newPage();
        await logIn(staffPage, staffPhone);
        await staffPage.waitForURL((url) => url.pathname === '/my-shifts');
        await expect(staffPage.getByTestId('my-shift-time').first()).toHaveText('19:00–23:00', { timeout: 15_000 });

        // The owner's Home approvals panel: the lock state comes from the server, not the device clock.
        await skipOtpResendWait(ownerPhone);
        const ownerPage = await ownerContext.newPage();
        await logIn(ownerPage, ownerPhone);
        await ownerPage.waitForURL((url) => url.pathname === '/');
        const approvals = ownerPage.getByRole('button', { name: /Conflict-Free Approvals/ });
        await expect(approvals).toBeVisible({ timeout: 15_000 });
        if ((await approvals.getAttribute('aria-expanded')) !== 'true') await approvals.click();
        await expect(ownerPage.getByText('Auto-locked — this shift was already reassigned')).toHaveCount(1, { timeout: 15_000 });
        await expect(ownerPage.getByRole('button', { name: 'Approve' })).toHaveCount(1);
      } finally {
        await staffContext.close();
        await ownerContext.close();
      }
    }
  });
});

/** The Monday (YYYY-MM-DD) of the week containing `iso` — same rule as src/engine/weekMath.ts. */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}
