import { test, expect, type Page, type Route } from '@playwright/test';
import type { SystemRole } from '@prisma/client';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Voice tools v2, the phone side: the typed command box, the visible steps, answers, declines,
 * the publish counts card, the cancel preview and every error state. Each /api/voice/* call is
 * stubbed with `page.route`, shaped exactly as the r14b contract says the server answers, so these
 * pin down what the app shows and sends without the model or e2e/fakeGemini.ts. Sign-in is real
 * (dev OTP echo). Names are made up.
 */

test.use({
  permissions: ['microphone'],
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

const usedPhones: string[] = [];

test.afterEach(async ({ page }) => {
  await page.close().catch(() => {});
  await cleanupTestOrgs();
  await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
});

/** A fresh venue with one signed-in person of this role; resolves once they land on their home screen. */
async function signIn(page: Page, systemRole: SystemRole): Promise<{ userId: string }> {
  const org = await prisma.organization.create({ data: { name: testVenueName(`voice-ui-${systemRole.toLowerCase()}`) } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  const user = await prisma.user.create({ data: { locationId: location.id, systemRole, fullName: `E2E Voice UI ${systemRole}`, phone } });
  const landing = systemRole === 'STAFF' ? '/my-shifts' : '/';
  try {
    await page.goto('/login');
  } catch {
    await page.goto('/login'); // same one-retry cold-Vite guard as helpers.ts
  }
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname === landing);
  return { userId: user.id };
}

interface Calls {
  parse: { transcript: string; source?: string }[];
  execute: { intent: { intent: string } }[];
  transcribe: number;
}

type Reply = { status?: number; body: unknown; delayMs?: number };

/**
 * Stubs the three voice endpoints. `parse` (and `execute`) answer each call in turn (the last one
 * repeats); a plain intent object becomes the contract's 200 body. Records every call.
 */
async function stubVoice(
  page: Page,
  { parse = [], execute = [{ body: { executed: true, result: {} } }], transcript = '' }: { parse?: (Reply | Record<string, unknown>)[]; execute?: Reply[]; transcript?: string } = {},
): Promise<Calls> {
  const calls: Calls = { parse: [], execute: [], transcribe: 0 };
  const fulfil = async (route: Route, reply: Reply) => {
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    // The app may have stopped waiting (its timeout) and aborted the request by now.
    await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body) }).catch(() => {});
  };
  await page.route('**/api/voice/transcribe', async (route) => {
    calls.transcribe++;
    await fulfil(route, { body: { transcript }, delayMs: 400 });
  });
  await page.route('**/api/voice/parse-intent', async (route) => {
    const body = route.request().postDataJSON() as { transcript: string; source?: string };
    calls.parse.push(body);
    const next = parse[Math.min(calls.parse.length - 1, parse.length - 1)];
    if (!next) throw new Error('No parse-intent answer stubbed');
    const reply: Reply = 'body' in next ? (next as Reply) : { body: { transcript: body.transcript, intent: next, voiceLogId: 'log-1', hasAdditionalRequest: false } };
    await fulfil(route, reply);
  });
  await page.route('**/api/voice/execute', async (route) => {
    calls.execute.push(route.request().postDataJSON() as Calls['execute'][number]);
    await fulfil(route, execute[Math.min(calls.execute.length - 1, execute.length - 1)]!);
  });
  return calls;
}

/** The typed command box (a dialog named by its heading). */
const composer = (page: Page) => page.getByRole('dialog').filter({ has: page.getByText('Type a command', { exact: true }) });

async function typeCommand(page: Page, words: string): Promise<void> {
  await page.getByRole('button', { name: 'Type a command' }).click();
  const box = composer(page);
  await expect(box.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
  await box.getByLabel("Type what you'd say").fill(words);
  await box.getByRole('button', { name: 'Send' }).click();
}

/** The confirm/answer sheet for a typed command. */
const sheet = (page: Page) => page.getByRole('dialog').filter({ hasText: 'You typed' });

test.describe('voice UI v2 (voice endpoints stubbed)', () => {
  test('typed command: the keyboard button beside the mic, then the same preview and Confirm (a split shift, both parts in full)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'MANAGER');
    const summary = 'Create a split Bartender shift for Alex Example on Friday 9 October.';
    const calls = await stubVoice(page, {
      parse: [
        {
          body: {
            transcript: 'x',
            voiceLogId: 'log-1',
            hasAdditionalRequest: false,
            intent: {
              intent: 'CREATE_SHIFT', roleId: 'role-1', date: '2026-10-09', start: '11:00', end: '15:00', second: { start: '18:00', end: '23:00' },
              userId: 'user-1', confidence: 0.94, summary, details: { person: 'Alex Example', personRole: 'Bartender', role: 'Bartender' },
            },
          },
          delayMs: 600,
        },
      ],
    });

    const said = 'Split shift for Alex on Friday, 11 to 3 and 6 to 11';
    await typeCommand(page, said);
    // The step shows in words while it is read.
    await expect(composer(page).getByRole('status')).toHaveText('Understanding…');

    const s = sheet(page);
    await expect(s.locator('.eyebrow')).toHaveText('New shift');
    await expect(s.getByRole('heading', { name: summary })).toBeVisible();
    await expect(s.getByText(`“${said}”`)).toBeVisible();
    await expect(s.getByText('Bartender · Split shift, two parts', { exact: true })).toBeVisible();
    await expect(s.getByText('1st: Friday 9 October 2026, 11:00 – 15:00', { exact: true })).toBeVisible();
    await expect(s.getByText('2nd: Friday 9 October 2026, 18:00 – 23:00', { exact: true })).toBeVisible();
    await expect(s.getByRole('status')).toHaveText('Ready to confirm');
    expect(calls.parse).toEqual([{ transcript: said, source: 'typed' }]);
    expect(calls.transcribe).toBe(0);

    await s.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText(`Done: ${summary}`);
    expect(calls.execute.map((c) => c.intent.intent)).toEqual(['CREATE_SHIFT']);
  });

  test('spoken command: Listening, Transcribing and Understanding are shown in words before the sheet', async ({ page }) => {
    const { userId } = await signIn(page, 'MANAGER');
    await page.evaluate((id) => localStorage.setItem(`shiftsync.voiceConsent.${id}`, '1'), userId);
    const said = 'Post an announcement: staff meeting Monday at 3';
    await stubVoice(page, {
      transcript: said,
      parse: [{ body: { transcript: said, voiceLogId: 'l', hasAdditionalRequest: false, intent: { intent: 'POST_ANNOUNCEMENT', content: 'Staff meeting Monday at 3pm.', confidence: 0.95, summary: 'Post an announcement to all staff.' } }, delayMs: 600 }],
    });

    await page.getByRole('button', { name: 'Start recording a voice command' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Listening… tap the mic to stop' })).toBeVisible();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: 'Stop recording voice command' }).click({ force: true });
    await expect(page.getByRole('status').filter({ hasText: 'Transcribing…' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Understanding…' })).toBeVisible();
    const s = page.getByRole('dialog').filter({ hasText: 'I heard' });
    await expect(s.getByRole('status')).toHaveText('Ready to confirm');
    await s.getByRole('button', { name: 'Cancel' }).click();
  });

  test('not understood: example phrases for the role fill the box without sending; Try again sends them', async ({ page }) => {
    await signIn(page, 'STAFF');
    const calls = await stubVoice(page, {
      parse: [
        { intent: 'UNRECOGNIZED', reason: 'Say it again, or fix what I heard and try again.', summary: "I didn't catch what you'd like to do." },
        { intent: 'QUERY_MY_SCHEDULE', confidence: 0.9, summary: 'You have no shifts in the next 14 days.', answer: { title: 'Your shifts — next 14 days', items: [], emptyText: 'You have no shifts in the next 14 days.' } },
      ],
    });

    await typeCommand(page, 'umm the thing');
    const s = sheet(page);
    await expect(s.locator('.eyebrow')).toHaveText("Didn't catch that");
    const examples = s.getByRole('group', { name: 'Examples to try' }).getByRole('button');
    await expect(examples).toHaveText(['When am I working this week?', "I can't work next Friday", 'Request next Monday to Wednesday off']);
    await examples.first().click();
    await expect(s.getByLabel(/You typed/)).toHaveValue('When am I working this week?');
    expect(calls.parse).toHaveLength(1); // filled, not sent

    await s.getByRole('button', { name: 'Try again' }).click();
    await expect(sheet(page).getByRole('heading', { name: 'Your shifts — next 14 days' })).toBeVisible();
    expect(calls.parse[1]).toEqual({ transcript: 'When am I working this week?', source: 'typed' });
  });

  test('a read: the answer as a list, Done and no Confirm, nothing executed; stored text stays text', async ({ page }) => {
    await signIn(page, 'MANAGER');
    const calls = await stubVoice(page, {
      parse: [
        {
          intent: 'WHO_IS_WORKING',
          confidence: 0.92,
          summary: 'Two people are working tonight.',
          answer: {
            title: 'Working tonight — Thursday 8 October 2026',
            items: [
              { primary: 'Alex Example', secondary: 'Bartender', tertiary: '18:00 – 02:00 (ends Friday)' },
              { primary: '<img src=x onerror="window.__voiceXss=1">', secondary: 'Waiter' },
            ],
            emptyText: 'Nobody is working tonight.',
          },
        },
      ],
    });

    await typeCommand(page, "Who's working tonight?");
    const s = sheet(page);
    await expect(s.locator('.eyebrow')).toHaveText("Who's working");
    await expect(s.getByRole('heading', { name: 'Working tonight — Thursday 8 October 2026' })).toBeVisible();
    const rows = s.getByRole('list', { name: 'Working tonight — Thursday 8 October 2026' }).getByRole('listitem');
    await expect(rows).toHaveText(['Alex Example Bartender 18:00 – 02:00 (ends Friday)', '<img src=x onerror="window.__voiceXss=1"> Waiter'], { useInnerText: true });
    await expect(s.getByRole('status')).toHaveText("Here's the answer");
    await expect(s.getByRole('button')).toHaveText(['Done']);
    expect(await page.evaluate(() => (window as { __voiceXss?: number }).__voiceXss)).toBeUndefined();
    await s.getByRole('button', { name: 'Done' }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(calls.execute).toEqual([]);
  });

  test("DECLINED: the server's message and a link to its screen; no Confirm, nothing executed", async ({ page }) => {
    await signIn(page, 'MANAGER');
    const message = "Removing or deactivating someone isn't done by voice. Do it in People.";
    const calls = await stubVoice(page, {
      parse: [{ intent: 'DECLINED', category: 'people_deactivate_delete', message, screen: { label: 'People', path: '/people' }, summary: 'Not by voice.', confidence: 1 }],
    });

    await typeCommand(page, 'Deactivate Alex Example');
    const s = sheet(page);
    await expect(s.locator('.eyebrow')).toHaveText('Not by voice');
    await expect(s.getByRole('heading', { name: message })).toBeVisible();
    await expect(s.getByRole('button', { name: /Confirm/ })).toHaveCount(0);
    await s.getByRole('link', { name: 'Open People' }).click();
    await page.waitForURL((url) => url.pathname === '/people');
    await expect(sheet(page)).toHaveCount(0);
    expect(calls.execute).toEqual([]);
  });

  test('publish: the stronger card states the shifts changing and the people notified, with its own Confirm', async ({ page }) => {
    await signIn(page, 'OWNER');
    const calls = await stubVoice(page, {
      parse: [{ intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', counts: { shiftsChanging: 12, peopleNotified: 8 }, confidence: 0.95, summary: 'Publish the rota for the week of 12 October.' }],
    });

    await typeCommand(page, "Publish next week's rota");
    const s = sheet(page);
    await expect(s.getByText('Before you publish')).toBeVisible();
    await expect(s.getByText('Week of Monday 12 October 2026')).toBeVisible();
    await expect(s.getByText('12 shifts will change and 8 people will be notified.', { exact: true })).toBeVisible();
    await expect(s.getByRole('button')).toHaveText(['Confirm: publish and notify 8 people', 'Edit', 'Cancel']);
    await s.getByRole('button', { name: 'Confirm: publish and notify 8 people' }).click();
    await expect(page.locator('.success-block')).toContainText('Done: Publish the rota for the week of 12 October.');
    expect(calls.execute.map((c) => c.intent)).toEqual([expect.objectContaining({ intent: 'PUBLISH_ROTA', weekStart: '2026-10-12' })]);
  });

  test('cancel shift: the person, their role, the full day and times, plainly a cancellation; "Keep shift" changes nothing', async ({ page }) => {
    await signIn(page, 'MANAGER');
    const calls = await stubVoice(page, {
      parse: [
        {
          intent: 'CANCEL_SHIFT', shiftId: 'shift-1', confidence: 0.93, summary: "Cancel Alex Example's Friday Bartender shift.",
          details: { person: 'Alex Example', personRole: 'Bartender', date: '2026-10-09', start: '18:30', end: '01:00', role: 'Bartender' },
        },
      ],
    });

    await typeCommand(page, "Cancel Alex's Friday shift");
    const s = sheet(page);
    await expect(s.locator('.eyebrow')).toHaveText('Cancel shift');
    await expect(s.getByText('Shift to cancel')).toBeVisible();
    await expect(s.getByText('Alex Example', { exact: true })).toBeVisible();
    await expect(s.getByText('Bartender · Friday 9 October 2026, 18:30 – 01:00 (ends Saturday)', { exact: true })).toBeVisible();
    await expect(s.getByText('This shift comes off the rota, and Alex Example is no longer working it.')).toBeVisible();
    await expect(s.getByRole('button')).toHaveText(['Confirm: cancel this shift', 'Edit', 'Keep shift']);
    await s.getByRole('button', { name: 'Keep shift' }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(calls.execute).toEqual([]);
  });

  test('microphone blocked: says so, how to turn it back on in iPhone Safari, and the typed box carries on', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await signIn(page, 'STAFF');
    const calls = await stubVoice(page, {
      parse: [{ intent: 'REQUEST_TIME_OFF', startDate: '2026-10-12', endDate: '2026-10-14', reason: 'Family visit', confidence: 0.9, summary: 'Request time off from 12 to 14 October.' }],
    });

    await page.getByRole('button', { name: 'Start recording a voice command' }).click();
    await page.getByRole('dialog', { name: 'Before you use voice' }).getByRole('button', { name: 'Use voice' }).click();
    const box = page.getByRole('dialog', { name: 'Microphone is off' });
    await expect(box.getByRole('alert')).toContainText("ShiftSync isn't allowed to use the microphone, so nothing was recorded.");
    await expect(box.getByRole('alert')).toContainText('tap “aA” in the address bar, then Website Settings → Microphone → Allow');
    await box.getByLabel('Type it instead').fill('Book Monday to Wednesday off for a family visit');
    await box.getByRole('button', { name: 'Send' }).click();

    const s = sheet(page);
    await expect(s.locator('.eyebrow')).toHaveText('Time off');
    await expect(s.getByText('From Monday 12 October 2026 to Wednesday 14 October 2026', { exact: true })).toBeVisible();
    await expect(s.getByText('Time off · 3 days')).toBeVisible();
    expect(calls.transcribe).toBe(0);
    expect(calls.parse.map((c) => c.source)).toEqual(['typed']);
  });

  test('offline: the mic and the typed box both say so and send nothing; back online it goes through', async ({ page, context }) => {
    await signIn(page, 'MANAGER');
    const calls = await stubVoice(page, {
      parse: [{ intent: 'POST_ANNOUNCEMENT', content: 'Staff meeting Monday at 3pm.', confidence: 0.95, summary: 'Post an announcement to all staff.' }],
    });

    await context.setOffline(true);
    await page.getByRole('button', { name: 'Start recording a voice command' }).click();
    const box = page.getByRole('dialog', { name: "You're offline" });
    await expect(box.getByRole('alert')).toHaveText('Voice needs a connection, so nothing was recorded. Reconnect and try again.');

    await box.getByLabel('Type it instead').fill('Announce staff meeting Monday at 3');
    await box.getByRole('button', { name: 'Send' }).click();
    await expect(box.getByRole('alert')).toHaveText('Nothing was sent. Reconnect, then send it again — your words are kept below.');
    await expect(box.getByLabel('Type it instead')).toHaveValue('Announce staff meeting Monday at 3');
    expect(calls.parse).toEqual([]);

    await context.setOffline(false);
    await box.getByRole('button', { name: 'Send' }).click();
    await expect(sheet(page).locator('.eyebrow')).toHaveText('Announcement');
    expect(calls.parse).toEqual([{ transcript: 'Announce staff meeting Monday at 3', source: 'typed' }]);
  });

  test('timeout: the app stops waiting with its own message and keeps the words to send again', async ({ page }) => {
    // The 25 s client timeout, shortened so this runs in about a second.
    await page.addInitScript(() => {
      (window as { __shiftsyncVoiceTimeoutMs?: number }).__shiftsyncVoiceTimeoutMs = 1000;
    });
    await signIn(page, 'MANAGER');
    await stubVoice(page, { parse: [{ body: {}, delayMs: 4000 }] });

    await typeCommand(page, "Who's working tonight?");
    const box = page.getByRole('dialog', { name: 'Taking too long' });
    await expect(box.getByRole('alert')).toHaveText(
      "The assistant didn't answer within 1 second, so I stopped waiting. Nothing changed. Try again, or type it below.",
    );
    await expect(box.getByLabel('Type it instead')).toHaveValue("Who's working tonight?");
  });

  test('a Confirm that timed out stays on the sheet; tapped again, the server says it was already done, and that is Done', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { __shiftsyncVoiceTimeoutMs?: number }).__shiftsyncVoiceTimeoutMs = 1000;
    });
    await signIn(page, 'MANAGER');
    const summary = 'Post an announcement to all staff.';
    const calls = await stubVoice(page, {
      parse: [{ intent: 'POST_ANNOUNCEMENT', content: 'Staff meeting Monday at 3pm.', confidence: 0.95, summary }],
      execute: [
        { body: { executed: true, result: {} }, delayMs: 4000 },
        { status: 409, body: { error: 'That command has already been done.', errorCode: 'voice_already_executed' } },
      ],
    });

    await typeCommand(page, 'Announce staff meeting Monday at 3');
    const s = sheet(page);
    await s.getByRole('button', { name: 'Confirm' }).click();
    await expect(s.getByRole('alert')).toContainText('Taking too long');
    await expect(s.getByRole('alert')).toContainText('It may still have gone through — check before you confirm again.');
    await s.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText(`Done: ${summary}`);
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Both taps carried the same voice log, which is what lets the server run it only once.
    expect(calls.execute.map((c) => (c as { voiceLogId?: string }).voiceLogId)).toEqual(['log-1', 'log-1']);
  });

  test('503 and 429: "assistant unavailable" and "limit reached", in the server\'s own words, with the typed box', async ({ page }) => {
    await signIn(page, 'MANAGER');
    await stubVoice(page, {
      parse: [
        { status: 503, body: { error: "Voice commands aren't available right now — try again later.", errorCode: 'voice_unavailable' } },
        { status: 429, body: { error: 'Too many requests — please wait a few minutes and try again.' } },
      ],
    });

    await typeCommand(page, 'Any pending requests?');
    const unavailable = page.getByRole('dialog', { name: 'Assistant unavailable' });
    await expect(unavailable.getByRole('alert')).toHaveText("Voice commands aren't available right now — try again later.");
    await unavailable.getByRole('button', { name: 'Send' }).click();
    const limit = page.getByRole('dialog', { name: 'Limit reached' });
    await expect(limit.getByRole('alert')).toHaveText('Too many requests — please wait a few minutes and try again.');
    await expect(limit.getByLabel('Type it instead')).toHaveValue('Any pending requests?');
  });
});
