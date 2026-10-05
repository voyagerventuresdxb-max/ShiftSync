import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';
import { geminiCalls, resetFakeGemini, scriptUtterance } from './fakeGemini';

/**
 * Profile → "Test AI connection" (owners only): one tiny image call and one tiny
 * audio call through the real API and spend cap, with Gemini faked at the
 * network boundary (e2e/fakeGemini.ts).
 */

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

test('owner: one line per AI feature; staff never see the panel', async ({ page }) => {
  await resetFakeGemini();
  const org = await prisma.organization.create({ data: { name: testVenueName('ai-self-test') } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const [ownerPhone, staffPhone] = [nextEchoPhone(), nextEchoPhone()];
  usedPhones.push(ownerPhone, staffPhone);
  await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'E2E AI Owner', phone: ownerPhone } });
  await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'E2E AI Staff', phone: staffPhone } });

  await logIn(page, ownerPhone);
  await page.goto('/profile');
  const panel = page.getByTestId('ai-connection');
  // The fake answers each test call with a scripted "transcript".
  await scriptUtterance('OK', { intent: 'UNRECOGNIZED', summary: 'unused' });
  await scriptUtterance('OK', { intent: 'UNRECOGNIZED', summary: 'unused' });
  await panel.getByRole('button', { name: 'Test AI connection' }).click();
  await expect(panel.locator('li').filter({ hasText: 'Roster photo reading:' })).toContainText('Working');
  await expect(panel.locator('li').filter({ hasText: 'Voice commands:' })).toContainText('Working');
  const calls = await geminiCalls();
  expect(calls.map((c) => c.body.contents?.[0]?.parts?.find((p) => p.inlineData)?.inlineData?.mimeType)).toEqual(['image/png', 'audio/wav']);

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await logIn(page, staffPhone);
  await page.goto('/profile');
  await expect(page.getByText('Delete account')).toBeVisible();
  await expect(page.getByTestId('ai-connection')).toHaveCount(0);
});
