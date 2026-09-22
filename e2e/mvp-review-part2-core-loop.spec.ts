import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { cleanupTestOrgs, continueThroughVenue, prisma, signupNewVenue, testVenueName } from './helpers';

/**
 * MVP readiness review, Part 2.2–2.3: the post-onboarding core loop as a
 * manager and then as a STAFF member, all through the real UI on the real
 * backend and a real Postgres schema. One long scenario per viewport, since
 * each step builds on the state the previous one created (a venue, a staff
 * member, a shift, a swap request, ...).
 *
 * Plus a tenant-isolation scenario: a second venue must neither see nor be
 * able to touch the first venue's announcements/shoutouts, while legitimate
 * same-venue use keeps working.
 */

const SHOTS = process.env.MVP_SHOTS_DIR ?? '';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Chrome logs every non-2xx fetch as "Failed to load resource" — an
    // expected 4xx from the API is not an app error; real JS errors are.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

/** Signs up a venue, skips Roster and Invite, lands the owner on the dashboard. */
async function ownerOnDashboard(page: Page, label: string): Promise<{ venueName: string; phone: string; locationId: string }> {
  const venueName = testVenueName(label);
  const { phone } = await signupNewVenue(page, venueName);
  await continueThroughVenue(page);
  await page.getByRole('button', { name: /Skip for now/ }).click();
  await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
  await page.getByRole('button', { name: /Skip — invite later/ }).click();
  await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
  await page.waitForURL(/\/$/, { timeout: 10000 });
  const location = await prisma.location.findFirst({ where: { name: venueName } });
  return { venueName, phone, locationId: location!.id };
}

/** Real staff self-registration through the invite link, ending in the "pending review" state. */
async function staffJoinsPending(page: Page, locationId: string, fullName: string): Promise<{ phone: string }> {
  const phone = `+97155${Date.now().toString().slice(-7)}`;
  await page.goto(`/join?location=${locationId}`);
  await expect(page.getByRole('heading', { name: 'Join ShiftSync' })).toBeVisible();
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('.font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByPlaceholder(/Full name/).fill(fullName);
  await page.getByRole('button', { name: 'Verify & continue' }).click();
  await expect(page.getByText(/your request has been submitted for review/)).toBeVisible();
  return { phone };
}

async function loginByPhone(page: Page, phone: string, expectedUrl: string | RegExp) {
  await page.goto('/join?mode=login');
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('.font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL(expectedUrl, { timeout: 15000 });
}

async function newPage(browser: Browser, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, baseURL: 'http://localhost:5173' });
  const page = await context.newPage();
  return { context, page };
}

// Audit scenario: long, seeds two rows directly in the DB to route around the
// two product gaps the report records (no Role-creation path without a roster
// upload; cover candidates limited to the week's roster). Opt-in so the default
// suite stays fast and free of DB workarounds: MVP_AUDIT=1 npx playwright test e2e/mvp-review-part2-core-loop.spec.ts
test.skip(!process.env.MVP_AUDIT, 'audit scenario — run with MVP_AUDIT=1');

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`core loop — ${viewport.name}`, () => {
    // A single stuck locator must fail fast, not eat the whole 10-minute budget.
    test.use({ viewport: { width: viewport.width, height: viewport.height }, actionTimeout: 20_000 });

    test.afterEach(async ({ page }) => {
      await page.close().catch(() => {});
      await cleanupTestOrgs();
    });

    test('manager dashboard → staff directory → rota → publish → staff joins → approval → staff view → swap → approval → hours', async ({ page, browser }) => {
      test.setTimeout(600_000);
      const errors = collectErrors(page);
      const { venueName, locationId } = await ownerOnDashboard(page, `p2-core-${viewport.name}`);
      // A day still ahead of 'today' in this week, so /my-shifts (upcoming only) lists it.
      const shiftDay = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

      // --- Dashboard: announcements post / edit / delete ---------------------
      await expect(page.getByText(venueName).first()).toBeVisible({ timeout: 15000 });
      await shot(page, `p2c-${viewport.name}-dashboard`);
      await page.getByRole('button', { name: 'Post' }).click();
      await page.getByPlaceholder('Share an update with the whole venue…').fill('Team meeting Friday 15:00 — all hands.');
      await page.getByRole('button', { name: 'Broadcast' }).click();
      await expect(page.getByText('Team meeting Friday 15:00 — all hands.')).toBeVisible();
      await page.getByRole('button', { name: 'Edit announcement' }).first().click();
      await page.getByPlaceholder('Share an update with the whole venue…').fill('Team meeting Friday 16:00 — all hands.');
      await page.getByRole('button', { name: 'Save edit' }).click();
      await expect(page.getByText('Team meeting Friday 16:00 — all hands.')).toBeVisible();
      await expect(page.getByText(/· edited/)).toBeVisible();

      // Approvals panel renders its empty state; safety valve renders.
      await page.getByRole('button', { name: /Conflict-Free Approvals/ }).click();
      await expect(page.getByText('No shift-swap requests yet')).toBeVisible();

      // --- People: staff directory add + pending approvals empty -------------
      await page.getByRole('link', { name: 'People' }).or(page.getByRole('button', { name: 'People' })).first().click();
      await page.waitForURL('**/people**');
      const directoryToggle = page.getByRole('button', { name: /Staff Directory/ });
      await expect(directoryToggle).toBeVisible();
      if ((await directoryToggle.getAttribute('aria-expanded')) !== 'true') await directoryToggle.click();
      await page.getByPlaceholder('Full name').fill('Layla Directory');
      await page.getByPlaceholder(/Job title/).fill('Bartender');
      await page.getByRole('button', { name: 'Add staff member' }).click();
      await expect(page.getByRole('cell', { name: 'Layla Directory' })).toBeVisible();
      await shot(page, `p2c-${viewport.name}-people`);

      // --- Staff joins via the real invite link, lands in Pending Approvals --
      const staff = await newPage(browser, viewport);
      const staffErrors = collectErrors(staff.page);
      const { phone: staffPhone } = await staffJoinsPending(staff.page, locationId, 'Omar Staff');
      await shot(staff.page, `p2c-${viewport.name}-join-pending`);

      await page.reload();
      await page.getByRole('button', { name: /Pending Approvals/ }).click();
      await expect(page.getByText('Omar Staff')).toBeVisible();
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByText('No join requests waiting for review.')).toBeVisible({ timeout: 10000 });
      // FINDING (low): the Staff Directory panel on the same page does not
      // refresh after an approval — the new member only appears after a
      // reload. Asserted after a reload here so the rest of the loop can run.
      const toggleAfterApprove = page.getByRole('button', { name: /Staff Directory/ });
      if ((await toggleAfterApprove.getAttribute('aria-expanded')) !== 'true') await toggleAfterApprove.click();
      await expect(page.getByRole('cell', { name: 'Layla Directory' })).toBeVisible();
      const staleDirectoryShowsOmar = await page.getByRole('cell', { name: 'Omar Staff' }).count();
      console.log(`[finding] directory showed approved member without reload: ${staleDirectoryShowsOmar > 0}`);
      if (staleDirectoryShowsOmar === 0) {
        await page.reload();
        const reloadedToggle = page.getByRole('button', { name: /Staff Directory/ });
        if ((await reloadedToggle.getAttribute('aria-expanded')) !== 'true') await reloadedToggle.click();
      }
      await expect(page.getByRole('cell', { name: 'Omar Staff' })).toBeVisible();
      const omar = await prisma.user.findFirst({ where: { locationId, fullName: 'Omar Staff' } });
      expect(omar?.systemRole).toBe('STAFF');
      expect(omar?.isActive).toBe(true);
      // FINDING (blocker-class, product decision): a Role is only ever created
      // by the roster-confirm path. A venue that skipped the roster upload has
      // zero roles, the Staff Directory cannot assign one (job title only), and
      // the rota builder's "New shift" sheet can only say "No roles found —
      // assign roles to staff in the Staff Directory first" — a control that
      // doesn't exist. Worked around here by seeding the role directly so the
      // rest of the loop can still be verified.
      const noRoleYet = await prisma.role.findFirst({ where: { locationId } });
      console.log(`[finding] venue has any Role after directory add + join approval: ${noRoleYet !== null}`);
      const bartender = await prisma.role.create({ data: { locationId, name: 'Bartender' } });
      await prisma.user.update({ where: { id: omar!.id }, data: { roleId: bartender.id } });
      const layla0 = await prisma.user.findFirst({ where: { locationId, fullName: 'Layla Directory' } });
      await prisma.user.update({ where: { id: layla0!.id }, data: { roleId: bartender.id } });

      // --- Scheduling: rota builder add shift + publish ----------------------
      await page.goto('/scheduling');
      await page.waitForURL('**/scheduling**');
      await expect(page.getByText('Weekly rota builder')).toBeVisible();
      const builderToggle = page.getByRole('button', { name: /Weekly rota builder/ });
      if ((await builderToggle.getAttribute('aria-expanded')) !== 'true') await builderToggle.click();
      await page.getByRole('button', { name: `Add shift on ${shiftDay}` }).first().scrollIntoViewIfNeeded();
      // Find Omar's row's first-day cell: the row label precedes 7 cells.
      const omarRow = page.locator('div.grid', { has: page.getByText('Omar Staff', { exact: true }) }).first();
      await omarRow.getByRole('button', { name: `Add shift on ${shiftDay}` }).click();
      await expect(page.getByRole('heading', { name: 'New shift' })).toBeVisible();
      await page.locator('select').filter({ hasText: 'Select a role…' }).selectOption({ label: 'Bartender' });
      await page.locator('input[type=time]').nth(0).fill('17:00');
      await page.locator('input[type=time]').nth(1).fill('23:00');
      await page.getByPlaceholder(/VIP table 12/).fill('Brief at 16:45');
      await page.getByRole('button', { name: 'Add shift', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'New shift' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /17:00–23:00/ })).toBeVisible();
      await expect(page.getByText('Draft', { exact: true })).toBeVisible();
      await shot(page, `p2c-${viewport.name}-rota-draft`);
      await page.getByRole('button', { name: /Publish & notify/ }).click();
      await expect(page.getByText('Published · locked')).toBeVisible({ timeout: 10000 });
      const omarShift = await prisma.shift.findFirst({ where: { locationId, userId: omar!.id } });
      expect(omarShift?.status).toBe('PUBLISHED');

      // Personal rota (manager viewing Omar) shows the shift; hour tracker lists him.
      await page.locator('select').filter({ hasText: 'Omar Staff' }).first().selectOption({ label: 'Omar Staff' });
      await expect(page.getByText('17:00 – 23:00')).toBeVisible();
      await expect(page.getByRole('paragraph').filter({ hasText: 'Brief at 16:45' })).toBeVisible();
      await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible();

      // Hours: clock Omar in and out on his behalf; tracker reflects it.
      await page.getByRole('button', { name: 'Clock in' }).click();
      await expect(page.getByRole('button', { name: 'Clock out' })).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: 'Clock out' }).click();
      await expect(page.getByRole('button', { name: 'Clock in' })).toBeVisible({ timeout: 10000 });
      const log = await prisma.attendanceLog.findFirst({ where: { userId: omar!.id } });
      expect(log?.clockOutAt ?? null, 'attendance log closed').not.toBeNull();
      await shot(page, `p2c-${viewport.name}-scheduling`);

      // --- Staff side: login, /my-shifts, availability, redirects -------------
      await loginByPhone(staff.page, staffPhone, '**/my-shifts**');
      await expect(staff.page.getByText('Welcome back, Omar Staff')).toBeVisible();
      // FINDING (low): staff-side times render in the browser locale/zone (12h here), manager side is 24h.
      await expect(staff.page.getByText(/Bartender · (17:00|05:00 PM)/)).toBeVisible();
      await expect(staff.page.getByText('Team meeting Friday 16:00 — all hands.')).toBeVisible();
      // Availability cycle on the first day of the week: unmarked -> unavailable -> preferred off -> unmarked.
      const day = staff.page.getByRole('button', { name: /^Mon .* — unmarked/ });
      await day.click();
      await expect(staff.page.getByRole('button', { name: /^Mon .* — unavailable/ })).toBeVisible();
      await staff.page.getByRole('button', { name: /^Mon .* — unavailable/ }).click();
      await expect(staff.page.getByRole('button', { name: /^Mon .* — preferred off/ })).toBeVisible();
      await shot(staff.page, `p2c-${viewport.name}-my-shifts`);

      // Manager-only pages: /schedule and /onboarding bounce STAFF to /my-shifts.
      await staff.page.goto('/schedule');
      await staff.page.waitForURL('**/my-shifts**');
      await staff.page.goto('/onboarding');
      await staff.page.waitForURL('**/my-shifts**');
      // /people renders read-only for STAFF: directory visible, no approvals panel, no add form.
      await staff.page.goto('/people');
      const staffDirectoryToggle = staff.page.getByRole('button', { name: /Staff Directory/ });
      await expect(staffDirectoryToggle).toBeVisible();
      if ((await staffDirectoryToggle.getAttribute('aria-expanded')) !== 'true') await staffDirectoryToggle.click();
      await expect(staff.page.getByText('Pending Approvals')).toHaveCount(0);
      await expect(staff.page.getByPlaceholder('Full name')).toHaveCount(0);
      await expect(staff.page.getByRole('cell', { name: 'Omar Staff' })).toBeVisible();

      // /scheduling for STAFF: Personal Rota of their own shift; request cover.
      // FINDING (medium): PersonalRota only offers 'Request cover' when another
      // colleague ALSO has a shift in the same week (candidates come from the
      // week's roster, not the Staff Directory). A lone-scheduled staff member
      // has no way to request cover. Worked around by giving Layla a published
      // shift the same week so the swap flow itself can be verified.
      const laylaUser = await prisma.user.findFirst({ where: { locationId, fullName: 'Layla Directory' } });
      await prisma.shift.create({ data: { locationId, roleId: bartender.id, userId: laylaUser!.id, createdById: laylaUser!.id, date: new Date(shiftDay + 'T00:00:00.000Z'), startTime: new Date(shiftDay + 'T06:00:00.000Z'), endTime: new Date(shiftDay + 'T12:00:00.000Z'), status: 'PUBLISHED' } });
      await staff.page.goto('/scheduling');
      // FINDING (medium, fixed on its own branch): the Viewing dropdown defaults to the
      // roster's first employee, not the signed-in STAFF user — so a staff member lands
      // on a colleague's rota. Selected explicitly here to verify the rest of the flow.
      const viewing = staff.page.locator('select').filter({ hasText: 'Omar Staff' }).first();
      const defaultViewed = await viewing.inputValue();
      console.log('[finding] staff Personal Rota defaulted to self: ' + (defaultViewed === omar!.id));
      await viewing.selectOption({ label: 'Omar Staff' });
      await expect(staff.page.getByText('17:00 – 23:00')).toBeVisible({ timeout: 15000 });
      await expect(staff.page.getByRole('link', { name: /Shift editor/ })).toHaveCount(0);
      await staff.page.getByRole('button', { name: 'Request cover' }).click();
      await staff.page.getByRole('article').filter({ has: staff.page.getByRole('button', { name: 'Send request' }) }).getByRole('combobox').selectOption({ label: 'Layla Directory' });
      await staff.page.getByRole('button', { name: 'Send request' }).click();
      await expect(staff.page.getByText('Cover request sent — awaiting manager approval.')).toBeVisible();
      await expect(staff.page.getByText('Swap pending')).toBeVisible();
      await shot(staff.page, `p2c-${viewport.name}-staff-scheduling`);

      // --- Manager approves the swap; shift reassigned -----------------------
      await page.goto('/');
      await page.getByRole('button', { name: /Conflict-Free Approvals/ }).click();
      await expect(page.getByText('Omar Staff', { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText('Layla Directory', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByText('Approved · shift reassigned')).toBeVisible({ timeout: 10000 });
      // The panel flips to 'Approved' optimistically; give the server write a moment before reading the DB.
      await expect.poll(async () => (await prisma.shiftSwapRequest.findFirst({ where: { shiftId: omarShift!.id } }))?.status, { timeout: 10000 }).toBe('APPROVED');
      const reassigned = await prisma.shift.findUnique({ where: { id: omarShift!.id } });
      const layla = await prisma.user.findFirst({ where: { locationId, fullName: 'Layla Directory' } });
      expect(reassigned?.userId).toBe(layla!.id);
      await shot(page, `p2c-${viewport.name}-approvals`);

      // Staff view reflects the reassignment: Omar no longer has that shift.
      await staff.page.goto('/my-shifts');
      await expect(staff.page.getByText('Welcome back, Omar Staff')).toBeVisible();
      await expect(staff.page.getByText('No upcoming shifts scheduled yet.')).toBeVisible({ timeout: 15000 });

      // --- Shoutout for Layla on the reassigned shift -----------------------
      await page.goto('/');
      await page.getByRole('button', { name: 'Tag a shift' }).click();
      await page.locator('select').filter({ hasText: 'Select team member…' }).selectOption({ value: layla!.id });
      await page.locator('select').filter({ hasText: /Select a shift…/ }).selectOption({ index: 1 });
      await page.getByPlaceholder('What did they do brilliantly on that shift?').fill('Covered at short notice — thank you.');
      await page.getByRole('button', { name: 'Give shoutout' }).click();
      await expect(page.getByText('Covered at short notice — thank you.')).toBeVisible();

      // Delete the announcement (last of the CRUD trio).
      await page.getByRole('button', { name: 'Delete announcement' }).first().click();
      await expect(page.getByText('Team meeting Friday 16:00 — all hands.')).toHaveCount(0);

      // Profile / logout round-trip for the manager.
      await page.getByRole('link', { name: 'Open your profile' }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.goto('/scheduling');
      await page.waitForURL('**/join?mode=login**');

      await staff.context.close();
      expect(errors, errors.join('\n')).toEqual([]);
      expect(staffErrors, staffErrors.join('\n')).toEqual([]);
    });
  });
}

test.describe('tenant isolation — announcements & shoutouts', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test("venue B cannot read, edit, delete or shout into venue A's feed; A's own use is unaffected", async ({ page, browser }) => {
    test.setTimeout(300_000);
    const a = await ownerOnDashboard(page, 'p2-iso-A');
    await page.getByRole('button', { name: 'Post' }).click();
    await page.getByPlaceholder('Share an update with the whole venue…').fill('Venue A private notice');
    await Promise.all([page.waitForResponse((r) => r.url().includes('/api/announcements') && r.request().method() === 'POST'), page.getByRole('button', { name: 'Broadcast' }).click()]);
    await expect(page.getByText('Venue A private notice')).toBeVisible();
    const announcement = await prisma.announcement.findFirst({ where: { locationId: a.locationId } });
    expect(announcement).not.toBeNull();

    const b = await newPage(browser, { width: 1440, height: 900 });
    const bInfo = await ownerOnDashboard(b.page, 'p2-iso-B');
    await expect(b.page.getByText(bInfo.venueName).first()).toBeVisible({ timeout: 15000 });
    await expect(b.page.getByText('Venue A private notice')).toHaveCount(0);
    await expect(b.page.getByText('No announcements yet.')).toBeVisible();

    const bToken = JSON.parse(await b.page.evaluate(() => localStorage.getItem('shiftsync.session') ?? '{}')).token as string;
    const headers = { Authorization: `Bearer ${bToken}`, 'Content-Type': 'application/json' };
    const patch = await b.page.request.patch(`/api/announcements/${announcement!.id}`, { headers, data: { body: 'hijacked' } });
    expect(patch.status()).toBe(404);
    const del = await b.page.request.delete(`/api/announcements/${announcement!.id}`, { headers });
    expect(del.status()).toBe(404);
    const aStaff = await prisma.user.findFirst({ where: { locationId: a.locationId } });
    const shout = await b.page.request.post('/api/shoutouts', { headers, data: { locationId: a.locationId, employeeId: aStaff!.id, note: 'cross-venue' } });
    expect([400, 403, 404]).toContain(shout.status());
    const still = await prisma.announcement.findUnique({ where: { id: announcement!.id } });
    expect(still?.body).toBe('Venue A private notice');

    // A can still edit its own announcement normally.
    await page.getByRole('button', { name: 'Edit announcement' }).first().click();
    await page.getByPlaceholder('Share an update with the whole venue…').fill('Venue A private notice (edited)');
    await page.getByRole('button', { name: 'Save edit' }).click();
    await expect(page.getByText('Venue A private notice (edited)')).toBeVisible();
    await b.context.close();
  });
});
