import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { cleanupTestOrgs, prisma, seedVenueWithRoles, signInAs } from './helpers';

/**
 * People → Staff Directory → "Import staff from a roster": the button opens the phone's file
 * picker, and the file goes through the same roster reader, review and confirm as onboarding
 * and the Scheduling page (one importer). Real backend and database; made-up names only.
 *
 * Set STAFF_IMPORT_SCREENS_DIR to also save screenshots of each step.
 */

// 390 wide by default; E2E_PHONE_WIDTH=360 runs the same checks on a smaller phone.
test.use({ viewport: { width: Number(process.env.E2E_PHONE_WIDTH) || 390, height: 844 }, hasTouch: true });

const CREW: [string, string][] = [
  ['Ava Thornton', 'Waiter'],
  ['Ben Okafor', 'Bartender'],
  ['Cleo Varga', 'Host'],
];
const DATES = ['2031-04-07', '2031-04-08'];

function rosterCsv(crew = CREW): Buffer {
  const lines = ['Employee Name,Role,Date,Start Time,End Time'];
  for (const [name, role] of crew) for (const date of DATES) lines.push(`${name},${role},${date},17:00,23:00`);
  return Buffer.from(lines.join('\n'));
}

function rosterXlsx(): Buffer {
  const rows: (string | number)[][] = [['Employee Name', 'Role', 'Date', 'Start Time', 'End Time']];
  for (const [name, role] of [['Dara Quill', 'Waiter'], ['Eli Marsh', 'Runner']] as const) for (const date of DATES) rows.push([name, role, date, '10:00', '18:00']);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Rota');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.STAFF_IMPORT_SCREENS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${test.info().project.name}-${name}.png`) });
}

async function openDirectory(page: Page, stored: string): Promise<void> {
  await signInAs(page, stored, '/people');
  const toggle = page.getByRole('button', { name: /Staff Directory/ });
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const importButton = (page: Page) => page.getByRole('button', { name: /Import staff from a roster/ });
const fileInput = (page: Page) => page.getByTestId('staff-import-file');

/** Counts roster uploads leaving the page (the progress poll excluded). */
function countUploads(page: Page): { n: number } {
  const seen = { n: 0 };
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/schedules\/upload$/.test(new URL(req.url()).pathname)) seen.n += 1;
  });
  return seen;
}

test.describe('staff directory — import staff from a roster', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('the button has an icon, a label and a 44px target, and opens the file picker for PDF, photos, Excel and CSV', async ({ page }) => {
    const v = await seedVenueWithRoles('staff-import-button');
    await openDirectory(page, v.sessions.MANAGER.stored);
    const button = importButton(page);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('Import staff from a roster');
    await expect(button).toHaveAttribute('aria-label', 'Import staff from a roster: PDF, photo, Excel or CSV');
    await expect(button.locator('svg')).toHaveCount(1);
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    await shot(page, '01-button');

    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
    expect(chooser.isMultiple()).toBe(false);
    const accept = (await fileInput(page).getAttribute('accept'))!.split(',');
    for (const t of ['.pdf', '.jpg', '.png', '.xlsx', '.csv', 'image/jpeg', 'application/pdf']) expect(accept).toContain(t);
    // No `capture`: an iPhone then offers Photo Library, Take Photo and Files, not the camera alone.
    expect(await fileInput(page).getAttribute('capture')).toBeNull();
  });

  test('CSV: review, confirm, everyone in the directory; the same file again adds nobody; a short name asks "same person?"', async ({ page }) => {
    test.setTimeout(180_000);
    const v = await seedVenueWithRoles('staff-import-csv');
    await openDirectory(page, v.sessions.OWNER.stored);
    await fileInput(page).setInputFiles({ name: 'team.csv', mimeType: 'text/csv', buffer: rosterCsv() });
    await expect(page.getByTestId('rr-header')).toHaveText('Found 3 people', { timeout: 20000 });
    await expect(page.getByTestId('roster-review')).toContainText('0 already on your staff · 3 new');
    await shot(page, '02-review');
    await page.getByTestId('rr-confirm').click();
    await expect(page.getByTestId('rr-result-lines')).toContainText('3 new people added to your staff');
    await shot(page, '03-result');
    // The directory reloads with them (3 seeded accounts + 3 imported).
    await expect(page.getByRole('button', { name: /Staff Directory/ })).toContainText('6');
    for (const [name] of CREW) await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();

    // The same file again: everyone is matched, nobody added.
    await page.getByRole('button', { name: 'Upload another roster' }).click();
    await fileInput(page).setInputFiles({ name: 'team.csv', mimeType: 'text/csv', buffer: rosterCsv() });
    await expect(page.getByTestId('roster-review')).toContainText('3 already on your staff · 0 new', { timeout: 20000 });
    await page.getByTestId('rr-confirm').click();
    await expect(page.getByTestId('rr-result-lines')).toContainText('0 new people added to your staff');
    await expect(page.getByTestId('rr-result-lines')).toContainText('3 matched to people already on your staff');

    // A short form of someone on staff is flagged as a question; Confirm waits for the answer.
    await page.getByRole('button', { name: 'Upload another roster' }).click();
    await fileInput(page).setInputFiles({ name: 'short.csv', mimeType: 'text/csv', buffer: rosterCsv([['Ava', 'Waiter']]) });
    const card = page.getByTestId('rr-person').first();
    await expect(card).toContainText('Possibly the same person as Ava Thornton — same person?', { timeout: 20000 });
    await expect(page.getByTestId('rr-confirm')).toBeDisabled();
    await shot(page, '04-same-person');
    await card.getByRole('button', { name: 'Same person' }).click();
    await page.getByTestId('rr-confirm').click();
    await expect(page.getByTestId('rr-result-lines')).toContainText('1 matched to people already on your staff');

    const staff = await prisma.user.findMany({ where: { locationId: v.locationId, systemRole: 'STAFF' }, select: { fullName: true } });
    expect(staff.map((s) => s.fullName).sort()).toEqual(['Ava Thornton', 'Ben Okafor', 'Cleo Varga', 'E2E staff staff-import-csv']);
  });

  test('Excel and a text PDF go through the same reader and review', async ({ page }) => {
    test.setTimeout(180_000);
    const v = await seedVenueWithRoles('staff-import-xlsx');
    await openDirectory(page, v.sessions.MANAGER.stored);
    await fileInput(page).setInputFiles({ name: 'rota.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: rosterXlsx() });
    await expect(page.getByTestId('rr-header')).toHaveText('Found 2 people', { timeout: 20000 });
    await page.getByTestId('rr-confirm').click();
    await expect(page.getByTestId('rr-result-lines')).toContainText('2 new people added to your staff');
    await expect(page.getByRole('cell', { name: 'Dara Quill', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Upload another roster' }).click();
    await fileInput(page).setInputFiles(resolve('server/test-fixtures/synthetic/text-roster.pdf'));
    await expect(page.getByTestId('rr-header')).toHaveText(/^Found \d+ people$/, { timeout: 30000 });
    await shot(page, '05-pdf-review');
  });

  test('a photo goes to the same reader: on a server without the AI reader it says so plainly, and nothing is saved', async ({ page }) => {
    const v = await seedVenueWithRoles('staff-import-photo');
    await openDirectory(page, v.sessions.MANAGER.stored);
    const uploads = countUploads(page);
    await fileInput(page).setInputFiles(resolve('server/test-fixtures/synthetic/roster.png'));
    await expect(page.getByRole('alert')).toContainText("AI roster reading isn't set up on this server.", { timeout: 20000 });
    expect(uploads.n).toBe(1);
    await expect(importButton(page)).toBeEnabled();
    expect(await prisma.user.count({ where: { locationId: v.locationId } })).toBe(3);
  });

  test('a wrong type, an empty file and a file over 10 MB are refused on the phone, with nothing sent', async ({ page }) => {
    const v = await seedVenueWithRoles('staff-import-refuse');
    await openDirectory(page, v.sessions.MANAGER.stored);
    const uploads = countUploads(page);
    await fileInput(page).setInputFiles({ name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not a roster') });
    await expect(page.getByRole('alert')).toContainText(`ShiftSync can't read "notes.docx". Choose a PDF, a photo (JPG, PNG or WebP), an Excel file or a CSV.`);
    await shot(page, '06-wrong-type');
    await fileInput(page).setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) });
    await expect(page.getByRole('alert')).toContainText('"empty.csv" is empty. Choose the roster file again.');
    await fileInput(page).setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
    await expect(page.getByRole('alert')).toContainText('"huge.pdf" is 10.0 MB; the limit is 10 MB.');
    // Picking the same file again is noticed (the picker is cleared after each pick).
    await fileInput(page).setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) });
    await expect(page.getByRole('alert')).toContainText('"empty.csv" is empty.');
    expect(uploads.n).toBe(0);
  });

  test('offline: the button is disabled and says why; nothing is sent', async ({ page, context }) => {
    const v = await seedVenueWithRoles('staff-import-offline');
    await openDirectory(page, v.sessions.MANAGER.stored);
    await expect(importButton(page)).toBeEnabled();
    await context.setOffline(true);
    await expect(importButton(page)).toBeDisabled();
    await expect(page.getByText("You're offline. Importing staff needs a connection.")).toBeVisible();
    await shot(page, '07-offline');
    await context.setOffline(false);
    await expect(importButton(page)).toBeEnabled();
  });

  test("the AI reader's weekly limit: the server's message is shown and nothing changes", async ({ page }) => {
    const v = await seedVenueWithRoles('staff-import-limit');
    // The upload answers as the server does when this venue's AI reads for the week are used up.
    const limitMessage =
      "AI-assisted roster reading for this venue was already used this week (last used 2031-04-01) — it's limited to 5 times per venue per week. It'll be available again on 2031-04-08. Try an Excel/CSV export in the meantime.";
    await page.addInitScript((message) => {
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/api\/schedules\/upload$/.test(new URL(url, location.href).pathname)) {
          return Promise.resolve(new Response(JSON.stringify({ error: message }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
        }
        return real(input, init);
      };
    }, limitMessage);
    await openDirectory(page, v.sessions.MANAGER.stored);
    await fileInput(page).setInputFiles(resolve('server/test-fixtures/synthetic/roster.png'));
    await expect(page.getByRole('alert')).toContainText('already used this week', { timeout: 20000 });
    await expect(page.getByRole('alert')).toContainText('Try an Excel/CSV export in the meantime.');
    await shot(page, '08-ai-limit');
    expect(await prisma.user.count({ where: { locationId: v.locationId } })).toBe(3);
  });

  test('a staff account sees no import button, and the server refuses its upload and confirm (403)', async ({ page, request }) => {
    const v = await seedVenueWithRoles('staff-import-staff');
    await openDirectory(page, v.sessions.STAFF.stored);
    await expect(page.getByRole('cell', { name: /E2E owner/ })).toBeVisible();
    await expect(importButton(page)).toHaveCount(0);
    await expect(fileInput(page)).toHaveCount(0);
    const auth = { Authorization: `Bearer ${v.sessions.STAFF.token}` };
    const upload = await request.post('http://localhost:4000/api/schedules/upload', {
      headers: auth,
      multipart: { file: { name: 'team.csv', mimeType: 'text/csv', buffer: rosterCsv() } },
    });
    expect(upload.status()).toBe(403);
    const confirm = await request.post('http://localhost:4000/api/schedules/upload/any-batch/confirm', { headers: auth, data: {} });
    expect(confirm.status()).toBe(403);
    expect(await prisma.user.count({ where: { locationId: v.locationId } })).toBe(3);
  });
});
