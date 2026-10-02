import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { prisma, TEST_ORG_PREFIX, cleanupTestOrgs } from './helpers';

/**
 * The whole login-link product flow, with two real browser contexts:
 *   manager signs in with their own link → People → "Send login link" for a
 *   staff member → the staff member opens that URL in a separate browser →
 *   the page shows who it is for WITHOUT spending the link → taps Sign in →
 *   lands on /my-shifts → the link is dead afterwards.
 * Nothing is intercepted; the server and DB are the real ones.
 */
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

test.describe('login links', () => {
  test.afterAll(async () => {
    await cleanupTestOrgs();
  });

  test('manager issues a link → staff opens it in another browser → taps Sign in → lands on /my-shifts', async ({ page, browser }) => {
    const org = await prisma.organization.create({ data: { name: `${TEST_ORG_PREFIX} login-links ${Date.now()}` } });
    const location = await prisma.location.create({
      data: { organizationId: org.id, name: 'Link Test Venue', emirate: 'Dubai', venueType: 'Fine Dining' },
    });
    const manager = await prisma.user.create({ data: { locationId: location.id, fullName: 'Link Manager', systemRole: 'MANAGER' } });
    const staff = await prisma.user.create({ data: { locationId: location.id, fullName: 'Link Staff', systemRole: 'STAFF' } });

    // The manager's own first link — minted the way the CLI/platform admin
    // would: only its hash is stored, the token goes in the fragment.
    const managerToken = randomBytes(32).toString('base64url');
    const managerLink = await prisma.loginLink.create({
      data: { tokenHash: sha256(managerToken), userId: manager.id, locationId: location.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    // --- Manager: open link, see who it is for, nothing spent yet, tap Sign in.
    await page.goto(`/login/link#${managerToken}`);
    await expect(page.getByRole('heading', { name: 'Sign in as Link Manager — Link Test Venue' })).toBeVisible();
    expect((await prisma.loginLink.findUniqueOrThrow({ where: { id: managerLink.id } })).consumedAt).toBeNull();
    await page.getByTestId('login-link-sign-in').click();
    await page.waitForURL('**/my-shifts');
    expect((await prisma.loginLink.findUniqueOrThrow({ where: { id: managerLink.id } })).consumedAt).not.toBeNull();

    // --- Manager: People → Staff Directory → Send login link for the staff member.
    await page.goto('/people');
    const toggle = page.getByRole('button', { name: /Staff Directory/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const row = page.getByRole('row').filter({ hasText: 'Link Staff' });
    await row.getByRole('button', { name: 'Send login link to Link Staff' }).click();
    const url = (await row.getByTestId('login-link-url').innerText()).trim();
    expect(url).toMatch(/^http:\/\/localhost:5173\/login\/link#[A-Za-z0-9_-]{43}$/);
    const staffLink = await prisma.loginLink.findFirstOrThrow({ where: { userId: staff.id }, orderBy: { createdAt: 'desc' } });
    expect(staffLink.issuedById).toBe(manager.id);

    // --- Staff member, in a completely separate browser (own storage, no manager session).
    const staffContext = await browser.newContext();
    try {
      const staffPage = await staffContext.newPage();
      await staffPage.goto(url);
      await expect(staffPage.getByRole('heading', { name: 'Sign in as Link Staff — Link Test Venue' })).toBeVisible();
      // Opening the page (a link scanner, a preview fetch, a curious tap) spends nothing.
      expect((await prisma.loginLink.findUniqueOrThrow({ where: { id: staffLink.id } })).consumedAt).toBeNull();

      await staffPage.getByTestId('login-link-sign-in').click();
      await staffPage.waitForURL('**/my-shifts');
      const spent = await prisma.loginLink.findUniqueOrThrow({ where: { id: staffLink.id } });
      expect(spent.consumedAt).not.toBeNull();
      expect(spent.redeemedIp).toBeTruthy();
      await expect(staffPage.getByText('Link Staff')).toBeVisible();
    } finally {
      await staffContext.close();
    }

    // --- The same link opened again anywhere is refused before any tap.
    const secondContext = await browser.newContext();
    try {
      const again = await secondContext.newPage();
      await again.goto(url);
      await expect(again.getByRole('alert')).toContainText('already been used');
      await expect(again.getByTestId('login-link-sign-in')).toHaveCount(0);
    } finally {
      await secondContext.close();
    }
  });
});
