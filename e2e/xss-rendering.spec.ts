import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Every user-entered or derived text field is shown as text, never run as markup: staff and
 * applicant names, role, section, shift briefing and side work, announcement, shoutout, floor
 * feedback, document title, venue name, roster-file names, and the kiosk view. Each payload sets
 * window.__xss to its own number if it ever executes.
 */
const P = (n: number, label: string) => `<img src=x onerror="window.__xss=${n}">${label}`;
const usedPhones: string[] = [];

async function logIn(page: Page, phone: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

async function expectInert(page: Page, where: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), `${where}: a payload executed`).toBe(0);
}

test.afterEach(async () => {
  await cleanupTestOrgs();
  await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
});

test('payloads in every text field render as text on every screen that shows them', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.addInitScript(() => {
    (window as unknown as { __xss: number }).__xss = 0;
  });

  const org = await prisma.organization.create({ data: { name: testVenueName('xss') } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: `${org.name} ${P(1, 'Venue')}`, timezone: 'Asia/Dubai' } });
  const [managerPhone, staffPhone] = [nextEchoPhone(), nextEchoPhone()];
  usedPhones.push(managerPhone, staffPhone);
  const manager = await prisma.user.create({ data: { locationId: location.id, systemRole: 'MANAGER', fullName: 'E2E XSS Manager', phone: managerPhone } });
  const staff = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: P(2, 'Staffer'), phone: staffPhone } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: P(3, 'Role') } });
  const plan = await prisma.floorPlanImage.create({ data: { locationId: location.id, fileUrl: `/uploads/floor-plans/xss-${Date.now()}.png`, mimeType: 'image/png' } });
  await prisma.floorSection.create({ data: { locationId: location.id, floorPlanImageId: plan.id, label: P(4, 'Section'), paxCapacity: 4 } });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Dubai' });
  await prisma.shift.create({
    data: {
      locationId: location.id, roleId: role.id, userId: staff.id, date: new Date(`${today}T00:00:00.000Z`),
      startTime: new Date(`${today}T20:00:00+04:00`), endTime: new Date(`${today}T23:00:00+04:00`), status: 'PUBLISHED',
      managerNotes: P(5, 'Briefing'), sidework: [P(6, 'Sidework')],
    },
  });
  await prisma.announcement.create({ data: { locationId: location.id, authorId: manager.id, body: P(7, 'Announcement') } });
  await prisma.shoutout.create({ data: { locationId: location.id, employeeId: staff.id, authorId: manager.id, note: P(8, 'Shoutout') } });
  await prisma.floorFeedback.create({ data: { locationId: location.id, userId: staff.id, content: P(9, 'Feedback') } });
  await prisma.policyDocument.create({ data: { locationId: location.id, category: 'Safety', title: P(10, 'Policy'), fileUrl: `/uploads/policy-documents/xss-${Date.now()}.pdf`, mimeType: 'application/pdf' } });
  await prisma.joinRequest.create({ data: { locationId: location.id, phone: nextEchoPhone(), fullName: P(11, 'Applicant') } });

  await logIn(page, managerPhone);
  for (const path of ['/', '/scheduling', '/people', '/floor-plan']) {
    await page.goto(path);
    await expectInert(page, path);
  }
  // At least one payload is visibly on screen as literal text (escaped, not dropped).
  await page.goto('/');
  await expect(page.getByText(/onerror=/).first()).toBeVisible();

  // Roster-derived names: a spreadsheet whose name cell is a payload.
  await page.goto('/scheduling');
  const csv = `Employee Name,Role,Date,Start Time,End Time\n<img src=x onerror=window.__xss=12>Rosa,Server,${today},10:00,18:00\n`;
  await page.locator('.upload-card input[type=file]').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText(/onerror=window.__xss=12/).first()).toBeVisible({ timeout: 20_000 });
  await expectInert(page, 'roster preview');

  // The kiosk screen (no session) for this venue.
  const url = await page.evaluate(async (locationId) => {
    const session = JSON.parse(localStorage.getItem('shiftsync.session') ?? '{}') as { token?: string };
    const res = await fetch(`/api/kiosk/${locationId}/regenerate`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } });
    return ((await res.json()) as { url: string }).url;
  }, location.id);
  const kiosk = new URL(url);
  await page.goto(`${kiosk.pathname}${kiosk.search}${kiosk.hash}`);
  await expect(page.getByText(/onerror=/).first()).toBeVisible();
  await expectInert(page, 'kiosk');

  // The staff member's own screens.
  await page.evaluate(() => localStorage.clear());
  await logIn(page, staffPhone);
  for (const path of ['/my-shifts', '/', '/profile']) {
    await page.goto(path);
    await expectInert(page, path);
  }
  expect(dialogs).toEqual([]);
});
