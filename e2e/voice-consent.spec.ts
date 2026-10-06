import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/** Profile → Voice commands: withdrawing consent turns voice off on this device until the person agrees again. */

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

test.afterEach(async () => {
  await cleanupTestOrgs();
  await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
});

test('withdrawing voice consent in Profile makes the microphone ask again before recording', async ({ page }) => {
  const org = await prisma.organization.create({ data: { name: testVenueName('voice-consent') } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  const staff = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'E2E Consent Staff', phone } });

  await logIn(page, phone);
  // As if they had agreed earlier on this device.
  await page.evaluate((id) => localStorage.setItem(`shiftsync.voiceConsent.${id}`, '1'), staff.id);

  await page.goto('/profile');
  const panel = page.getByTestId('voice-consent');
  await panel.getByRole('button', { name: 'Turn off voice on this device' }).click();
  await expect(panel.getByRole('status')).toContainText('Voice is off on this device');
  expect(await page.evaluate((id) => localStorage.getItem(`shiftsync.voiceConsent.${id}`), staff.id)).toBeNull();

  await page.goto('/my-shifts');
  await page.getByRole('button', { name: 'Start recording a voice command' }).click();
  await expect(page.getByRole('dialog', { name: 'Before you use voice' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop recording voice command' })).toHaveCount(0);
});
