import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * In-app account deletion (App Store / Google Play requirement) and the DRAFT legal pages.
 * Real backend + real DB; users are created directly with allowlisted phones.
 */
const usedPhones: string[] = [];

async function venueWith(roles: ('OWNER' | 'MANAGER' | 'STAFF')[]): Promise<{ locationId: string; phones: string[] }> {
  const org = await prisma.organization.create({ data: { name: testVenueName('account-deletion') } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const phones: string[] = [];
  for (const [i, systemRole] of roles.entries()) {
    const phone = nextEchoPhone();
    usedPhones.push(phone);
    phones.push(phone);
    await prisma.user.create({ data: { locationId: location.id, systemRole, fullName: `E2E Deletion ${systemRole} ${i}`, phone } });
  }
  return { locationId: location.id, phones };
}

async function logIn(page: Page, phone: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

test.describe('account deletion + draft legal pages', () => {
  test.use({ actionTimeout: 20_000 });

  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('staff deletes their own account from Profile: confirm first, then signed out with a notice; the row is de-identified', async ({ page }) => {
    const { locationId, phones } = await venueWith(['OWNER', 'STAFF']);
    await logIn(page, phones[1]!);
    await page.goto('/profile');

    const section = page.getByTestId('delete-account');
    await section.getByRole('button', { name: 'Delete my account…' }).click();
    await expect(section.getByRole('alertdialog')).toContainText("can't be undone");
    // Nothing happened yet.
    expect(await prisma.user.count({ where: { locationId, phone: phones[1]!, deletedAt: null } })).toBe(1);

    await page.getByTestId('delete-account-confirm').click();
    await page.waitForURL(/\/login\?reason=account-deleted/);
    await expect(page.getByTestId('account-deleted-notice')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('shiftsync.session'))).toBeNull();

    const row = await prisma.user.findFirstOrThrow({ where: { locationId, systemRole: 'STAFF' } });
    expect(row).toMatchObject({ fullName: 'Deleted user', phone: null, isActive: false });
    expect(row.deletedAt).not.toBeNull();
    expect(await prisma.session.count({ where: { userId: row.id } })).toBe(0);
  });

  test('the only owner is told why their account cannot be deleted, and nothing changes', async ({ page }) => {
    const { locationId, phones } = await venueWith(['OWNER']);
    await logIn(page, phones[0]!);
    await page.goto('/profile');
    await page.getByRole('button', { name: 'Delete my account…' }).click();
    await page.getByTestId('delete-account-confirm').click();
    await expect(page.getByRole('alert')).toContainText("You're the only owner of this venue");
    expect(await prisma.user.count({ where: { locationId, systemRole: 'OWNER', isActive: true, deletedAt: null } })).toBe(1);
  });

  test('privacy and terms drafts are linked from sign-in and clearly marked as drafts', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('legal-links').getByRole('link', { name: 'Privacy policy (draft)' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByTestId('legal-draft-banner')).toContainText('DRAFT — needs legal review — not yet in force');
    await expect(page.getByRole('heading', { name: 'Privacy policy (draft)' })).toBeVisible();
    await page.goto('/terms');
    await expect(page.getByTestId('legal-draft-banner')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Terms of use (draft)' })).toBeVisible();
  });
});
