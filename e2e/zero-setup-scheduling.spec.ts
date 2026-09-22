import { test, expect, type Page } from '@playwright/test';
import { cleanupTestOrgs, continueThroughVenue, prisma, signupNewVenue, testVenueName } from './helpers';
import { DEFAULT_ROLES } from '../shared/defaultRoles';

/**
 * Zero-setup scheduling: a brand-new venue that never uploads a roster can
 * still build a rota immediately, because signup seeds a default role set.
 * Then the Staff Directory's role controls stay in sync with the rota
 * builder: assign, rename, remove, add — all through the real UI.
 */

async function openDirectory(page: Page) {
  await page.goto('/people');
  const toggle = page.getByRole('button', { name: /Staff Directory/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

test.describe('zero-setup scheduling — default roles + Staff Directory role control', () => {
  test.use({ actionTimeout: 20_000 });

  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('fresh signup → default roles → shift with no roster upload → directory add/rename/remove stays in sync with the rota', async ({ page }) => {
    test.setTimeout(240_000);
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (m) => {
      // 'Cannot update a component … StaffDirectory' is the pre-existing
      // setState-in-render warning fixed separately in PR #34 — not this
      // feature's; drop this exclusion once #34 lands.
      if (m.type() === 'error' && !/Failed to load resource|while rendering a different component/.test(m.text())) consoleErrors.push(m.text());
    });

    const venueName = testVenueName('zero-setup');
    await signupNewVenue(page, venueName);
    await continueThroughVenue(page);
    await page.getByRole('button', { name: /Skip for now/ }).click();
    await page.waitForSelector('text=Venue join-link', { timeout: 15000 });
    await page.getByRole('button', { name: /Skip — invite later/ }).click();
    await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
    await page.waitForURL(/\/$/, { timeout: 10000 });
    const location = await prisma.location.findFirst({ where: { name: venueName } });
    const shiftDay = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

    // Default roles exist in the DB and in the directory's Roles panel.
    const seeded = await prisma.role.findMany({ where: { locationId: location!.id } });
    expect(seeded.map((r) => r.name).sort()).toEqual([...DEFAULT_ROLES].sort());
    await openDirectory(page);
    for (const name of DEFAULT_ROLES) await expect(page.getByRole('textbox', { name: `Role name: ${name}` })).toBeVisible();

    // Assign a default role to the owner (the only staff member so far).
    const ownerRole = page.getByRole('combobox', { name: 'Role for E2E Test Owner' });
    await ownerRole.selectOption({ label: 'Bartender' });
    await expect.poll(async () => (await prisma.user.findFirst({ where: { locationId: location!.id, fullName: 'E2E Test Owner' }, include: { role: true } }))?.role?.name).toBe('Bartender');

    // Rename Bartender → Mixologist; the owner's row follows without a reload.
    const bartenderInput = page.getByRole('textbox', { name: 'Role name: Bartender' });
    await bartenderInput.fill('Mixologist');
    await bartenderInput.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Role name: Mixologist' })).toBeVisible();
    await expect(ownerRole).toHaveValue(seeded.find((r) => r.name === 'Bartender')!.id);
    await expect(ownerRole.locator('option:checked')).toHaveText('Mixologist');

    // Rota builder, no roster ever uploaded: the renamed role is offered and a shift can be created.
    await page.goto('/scheduling');
    const builderToggle = page.getByRole('button', { name: /Weekly rota builder/ });
    if ((await builderToggle.getAttribute('aria-expanded')) !== 'true') await builderToggle.click();
    await page.getByRole('button', { name: `Add shift on ${shiftDay}` }).first().click();
    await expect(page.getByRole('heading', { name: 'New shift' })).toBeVisible();
    const roleSelect = page.locator('select').filter({ hasText: 'Select a role…' });
    for (const name of ['Mixologist', 'Chef', 'Host']) await expect(roleSelect.locator('option', { hasText: name })).toHaveCount(1);
    await expect(roleSelect.locator('option', { hasText: 'Bartender' })).toHaveCount(0);
    await roleSelect.selectOption({ label: 'Mixologist' });
    await page.locator('input[type=time]').nth(0).fill('17:00');
    await page.locator('input[type=time]').nth(1).fill('23:00');
    await page.getByRole('button', { name: 'Add shift', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New shift' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /17:00–23:00/ })).toBeVisible();
    const shift = await prisma.shift.findFirst({ where: { locationId: location!.id }, include: { role: true } });
    expect(shift?.role.name).toBe('Mixologist');

    // Remove Mixologist and add Sommelier in the directory.
    await openDirectory(page);
    await page.getByRole('button', { name: 'Remove role Mixologist' }).click();
    await expect(page.getByRole('textbox', { name: 'Role name: Mixologist' })).toHaveCount(0);
    await expect(ownerRole).toHaveValue('');
    await page.getByPlaceholder('New role (e.g. Sommelier)').fill('Sommelier');
    await page.getByRole('button', { name: 'Add role' }).click();
    await expect(page.getByRole('textbox', { name: 'Role name: Sommelier' })).toBeVisible();

    // Rota builder reflects both: the existing shift is intact and still
    // labelled, Mixologist is no longer offered for a new shift, Sommelier is.
    await page.goto('/scheduling');
    if ((await builderToggle.getAttribute('aria-expanded')) !== 'true') await builderToggle.click();
    await expect(page.getByRole('button', { name: /17:00–23:00/ })).toBeVisible();
    expect((await prisma.shift.findUnique({ where: { id: shift!.id } }))?.roleId).toBe(shift!.roleId);
    await page.getByRole('button', { name: `Add shift on ${shiftDay}` }).last().click();
    const roleSelect2 = page.locator('select').filter({ hasText: 'Select a role…' });
    await expect(roleSelect2.locator('option', { hasText: 'Sommelier' })).toHaveCount(1);
    await expect(roleSelect2.locator('option', { hasText: 'Mixologist' })).toHaveCount(0);

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });
});
