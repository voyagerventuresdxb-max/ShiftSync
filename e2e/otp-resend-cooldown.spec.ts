import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { cleanupTestOrgs, nextEchoPhone, prisma, skipOtpResendWait, testVenueName } from './helpers';

/**
 * "Send a new code" on /login and on the join form: disabled with a countdown
 * for 30s after a code, enabled afterwards, and when the server still refuses
 * (its own per-phone cap) the message shows and the countdown restarts from
 * the server's Retry-After. The browser clock is faked (page.clock) so the
 * 30s pass instantly on the client while the server's real clock has not
 * moved — exactly the case where the client must defer to the server.
 */
const usedPhones: string[] = [];

async function open(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path);
  } catch {
    await page.goto(path);
  }
}

const resendButton = (page: Page) => page.getByRole('button', { name: /Send a new code/ });

async function exerciseResend(page: Page, phone: string, requestOtpPath: string): Promise<void> {
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const firstCode = (await page.locator('p.hint .font-mono').innerText()).trim();

  // Counting down, disabled.
  await expect(resendButton(page)).toBeDisabled();
  await expect(resendButton(page)).toHaveText(/Send a new code in (30|29|28)s/);

  // 31 client-seconds later the button is live, but the server's 30s cap has NOT passed.
  await page.clock.fastForward(31_000);
  await expect(resendButton(page)).toBeEnabled();
  await expect(resendButton(page)).toHaveText('Send a new code');
  const refused = page.waitForResponse((r) => r.url().endsWith(requestOtpPath));
  await resendButton(page).click();
  expect((await refused).status()).toBe(429);
  await expect(page.locator('.error-block')).toContainText('Too many code requests for this number');
  // The client defers to the server: counting down again, from the server's Retry-After (≤30s).
  await expect(resendButton(page)).toBeDisabled();
  await expect(resendButton(page)).toHaveText(/Send a new code in \d+s/);

  // Server cap cleared (the earlier code aged by 60s in the DB) → a real new code arrives.
  await skipOtpResendWait(phone);
  await page.clock.fastForward(31_000);
  await expect(resendButton(page)).toBeEnabled();
  const ok = page.waitForResponse((r) => r.url().endsWith(requestOtpPath));
  await resendButton(page).click();
  expect((await ok).status()).toBe(200);
  await expect(page.locator('.error-block')).toHaveCount(0);
  const secondCode = (await page.locator('p.hint .font-mono').innerText()).trim();
  expect(secondCode).not.toBe(firstCode);
  await expect(resendButton(page)).toBeDisabled();
}

test.describe('"Send a new code" cooldown honours the server rate limit', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
    await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
  });

  test('/login: 30s countdown, then the server 429 is shown and the countdown restarts, then a fresh code', async ({ page }) => {
    const phone = nextEchoPhone();
    usedPhones.push(phone);
    const org = await prisma.organization.create({ data: { name: testVenueName('resend-login') } });
    const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
    await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'E2E Resend Staff', phone } });

    await page.clock.install();
    await open(page, '/login');
    await exerciseResend(page, phone, '/api/identity/request-otp');
  });

  test('join link: the same button and cooldown on the join form', async ({ page }) => {
    const phone = nextEchoPhone();
    usedPhones.push(phone);
    const org = await prisma.organization.create({ data: { name: testVenueName('resend-join') } });
    const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name, emirate: 'Dubai', venueType: 'Fine Dining' } });
    const owner = await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'E2E Resend Owner' } });
    const link = await prisma.inviteLink.create({
      data: { locationId: location.id, token: randomBytes(32).toString('base64url'), createdById: owner.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });

    await page.clock.install();
    await open(page, `/join?invite=${link.token}`);
    await expect(page.getByRole('heading', { name: /Join .* (on ShiftSync|as staff)/ })).toBeVisible();
    await exerciseResend(page, phone, '/api/join/request-otp');
  });
});
