import { test, expect, type Page, type Route } from '@playwright/test';
import type { SystemRole } from '@prisma/client';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * The full-height voice sheet (VoiceStage) and its confirm sheet: edit what was heard and run it
 * again, the typed fallback, "Which one?", what the confirm sheet says, reduced motion, the
 * microphone released on close, keyboard-only use, and 50 open/close cycles. Every /api/voice/*
 * call is stubbed (no model, no key); sign-in is real (dev OTP echo). Names are made up.
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

async function signIn(page: Page, systemRole: SystemRole): Promise<{ userId: string }> {
  const org = await prisma.organization.create({ data: { name: testVenueName(`voice-sheet-${systemRole.toLowerCase()}`) } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  const user = await prisma.user.create({ data: { locationId: location.id, systemRole, fullName: `E2E Voice Sheet ${systemRole}`, phone } });
  const landing = systemRole === 'STAFF' ? '/my-shifts' : '/';
  try {
    await page.goto('/login');
  } catch {
    await page.goto('/login');
  }
  await page.getByPlaceholder('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.locator('p.hint .font-mono').innerText()).trim();
  await page.getByPlaceholder('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify & log in' }).click();
  await page.waitForURL((url) => url.pathname === landing);
  // Voice consent already given on this device (the consent sheet has its own spec).
  await page.evaluate((id) => localStorage.setItem(`shiftsync.voiceConsent.${id}`, '1'), user.id);
  return { userId: user.id };
}

interface Calls {
  parse: { transcript: string; source?: string }[];
  execute: { intent: Record<string, unknown> }[];
  transcribe: number;
}
type Reply = { status?: number; body: unknown; delayMs?: number };

async function stubVoice(
  page: Page,
  { parse = [], execute = [{ body: { executed: true, result: {} } }], transcript = '', transcribeDelayMs = 300 }: { parse?: (Reply | Record<string, unknown>)[]; execute?: Reply[]; transcript?: string; transcribeDelayMs?: number } = {},
): Promise<Calls> {
  const calls: Calls = { parse: [], execute: [], transcribe: 0 };
  const fulfil = async (route: Route, reply: Reply) => {
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body) }).catch(() => {});
  };
  await page.route('**/api/voice/transcribe', async (route) => {
    calls.transcribe++;
    await fulfil(route, { body: { transcript }, delayMs: transcribeDelayMs });
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

/** The full-height voice sheet while it is on top (named by its step, its typed box or its problem). */
const stage = (page: Page) => page.locator('.voice-stage > [role="dialog"]');
/** The confirm sheet: the one dialog showing what was heard or typed. */
const confirmSheet = (page: Page, origin: 'I heard' | 'You typed' = 'I heard') => page.getByRole('dialog').filter({ hasText: origin });

async function record(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start recording a voice command' }).click();
  await expect(stage(page).getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
  await page.waitForTimeout(600);
  // The recording ring animates, so the button never passes Playwright's stability check.
  await stage(page).getByRole('button', { name: 'Stop recording voice command' }).click({ force: true });
}

const alexShoutout = (note: string) => ({
  intent: 'POST_SHOUTOUT',
  targetUserId: 'user-alex',
  targetUserName: 'Alex Example',
  content: note,
  confidence: 0.95,
  summary: 'Give Alex Example a shout-out with this note.',
  details: { person: 'Alex Example', personRole: 'Bartender' },
});

test.describe('voice sheet (endpoints stubbed)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('edit what was heard, then Run it: the same reading again from the edited words, nothing recorded again; only the new reading is confirmed', async ({ page }) => {
    await signIn(page, 'MANAGER');
    const heard = 'Give Alex a shout-out for the spotless bar';
    const calls = await stubVoice(page, { transcript: heard, parse: [alexShoutout('Spotless bar'), alexShoutout('Spotless bar and great service')] });

    await record(page);
    // The words appear on the sheet once transcribed (no live captions while speaking).
    const sheet = confirmSheet(page);
    await expect(sheet.getByText(`“${heard}”`)).toBeVisible();
    await expect(sheet.getByRole('status')).toHaveText('Ready to confirm');

    await sheet.getByRole('button', { name: 'Edit' }).click();
    const box = sheet.getByLabel(/I heard/);
    await expect(box).toHaveValue(heard);
    const fixed = 'Give Alex a shout-out for the spotless bar and great service';
    await box.fill(fixed);
    await sheet.getByRole('button', { name: 'Run it' }).click();

    const again = page.getByRole('dialog').filter({ hasText: `“${fixed}”` });
    await expect(again.getByText('Spotless bar and great service', { exact: true })).toBeVisible();
    expect(calls.transcribe).toBe(1);
    expect(calls.parse).toEqual([
      { transcript: heard, source: 'voice' },
      { transcript: fixed, source: 'typed' },
    ]);
    expect(calls.execute).toEqual([]);

    await again.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText('Done: Give Alex Example a shout-out with this note.');
    expect(calls.execute.map((c) => c.intent.content)).toEqual(['Spotless bar and great service']);
  });

  test('typed fallback inside the sheet: a reading that timed out keeps the heard words in the box; Send goes on to the same Confirm', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { __shiftsyncVoiceTimeoutMs?: number }).__shiftsyncVoiceTimeoutMs = 1000;
    });
    await signIn(page, 'MANAGER');
    const heard = 'Give Alex a shout-out for the spotless bar';
    const calls = await stubVoice(page, { transcript: heard, parse: [{ body: {}, delayMs: 4000 }, alexShoutout('Spotless bar')] });

    await record(page);
    const sheet = page.getByRole('dialog', { name: 'Taking too long' });
    await expect(sheet.getByRole('alert')).toContainText("The assistant didn't answer within 1 second");
    await expect(sheet.getByLabel('Type it instead')).toHaveValue(heard);
    // The same sheet: the mic is still there to try again by voice, and the keyboard is on.
    await expect(sheet.getByRole('button', { name: 'Start recording a voice command' })).toBeEnabled();
    await expect(sheet.getByRole('button', { name: 'Type instead' })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: 'Send' }).click();

    const confirm = confirmSheet(page, 'You typed');
    await expect(confirm.getByText('Alex Example', { exact: true })).toBeVisible();
    await confirm.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText('Done:');
    expect(calls.transcribe).toBe(1);
    expect(calls.parse.map((c) => c.source)).toEqual(['voice', 'typed']);
    expect(calls.execute).toHaveLength(1);
  });

  test('Which one: real names with their roles as tappable cards; choosing one previews it; only that person is confirmed', async ({ page }) => {
    await signIn(page, 'MANAGER');
    const karim = (id: string, name: string, role: string) => ({
      intent: 'POST_SHOUTOUT', targetUserId: id, targetUserName: name, content: 'Well done', confidence: 0.9, summary: `Give ${name} a shout-out.`, details: { person: name, personRole: role },
    });
    const calls = await stubVoice(page, {
      transcript: 'Give Karim a shout-out saying well done',
      parse: [
        {
          intent: 'UNRECOGNIZED', reason: 'Two people at your venue are called Karim.', summary: 'Which Karim did you mean?', person: { heard: 'Karim', status: 'ambiguous' },
          options: [karim('user-aziz', 'Karim Aziz', 'Runner'), karim('user-saleh', 'Karim Saleh', 'Bartender')],
        },
      ],
    });

    await record(page);
    const sheet = confirmSheet(page);
    await expect(sheet.getByRole('heading', { name: 'Which Karim did you mean?' })).toBeVisible();
    const people = sheet.getByRole('group', { name: 'People to choose from' }).getByRole('button');
    await expect(people).toHaveText([/Karim Aziz · Runner/, /Karim Saleh · Bartender/]);
    await expect(sheet.getByRole('button', { name: /^Confirm/ })).toHaveCount(0);

    await people.filter({ hasText: 'Karim Saleh' }).click();
    await expect(sheet.getByRole('heading', { name: 'Give Karim Saleh a shout-out.' })).toBeVisible();
    await expect(sheet.getByText('For Karim Saleh · Bartender')).toBeVisible();
    await sheet.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.success-block')).toContainText('Give Karim Saleh a shout-out.');
    expect(calls.execute.map((c) => c.intent.targetUserId)).toEqual(['user-saleh']);
  });

  test('the confirm sheet says who, in which role, on which day and date, and when', async ({ page }) => {
    await signIn(page, 'MANAGER');
    await stubVoice(page, {
      transcript: 'Put Alex on Friday from half six to one, bar',
      parse: [
        {
          intent: 'CREATE_SHIFT', roleId: 'role-1', date: '2026-10-09', start: '18:30', end: '01:00', userId: 'user-alex', confidence: 0.94,
          summary: 'Create a Bartender shift for Alex Example on Friday, 18:30 to 01:00.', details: { person: 'Alex Example', personRole: 'Bartender', role: 'Bartender' },
        },
      ],
    });
    await record(page);
    const sheet = confirmSheet(page);
    await expect(sheet.getByText('Alex Example', { exact: true })).toBeVisible();
    await expect(sheet.getByText('Bartender · Friday 9 October 2026, 18:30 – 01:00 (ends Saturday)', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button')).toHaveText(['Confirm', 'Edit', 'Cancel']);
  });

  test('reduced motion: nothing in the voice sheet animates and the orb is one still frame', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page, 'MANAGER');
    await page.getByRole('button', { name: 'Start recording a voice command' }).click();
    const s = stage(page);
    await expect(s.getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
    const canvas = s.locator('canvas');
    await expect(canvas).toBeVisible();
    expect(await page.locator('.voice-stage').evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    const first = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await page.waitForTimeout(700);
    expect(await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(first);
    await s.getByRole('button', { name: 'Cancel' }).click();
    await expect(stage(page)).toHaveCount(0);
  });

  test('with motion allowed the orb moves (so the still frame above is a real difference)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await signIn(page, 'MANAGER');
    await page.getByRole('button', { name: 'Start recording a voice command' }).click();
    const canvas = stage(page).locator('canvas');
    await expect(canvas).toBeVisible();
    await page.waitForTimeout(300);
    const first = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await page.waitForTimeout(500);
    expect(await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(first);
    await stage(page).getByRole('button', { name: 'Cancel' }).click();
  });

  test('closing while recording releases the microphone and its audio context, and sends nothing', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __streams: MediaStream[]; __contexts: AudioContext[] };
      w.__streams = [];
      w.__contexts = [];
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await gum(c);
        w.__streams.push(s);
        return s;
      };
      const Ctx = window.AudioContext;
      window.AudioContext = class extends Ctx {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args);
          w.__contexts.push(this);
        }
      } as typeof AudioContext;
    });
    await signIn(page, 'MANAGER');
    const calls = await stubVoice(page, { transcript: 'should never be sent', parse: [alexShoutout('x')] });

    for (const how of ['Close', 'Cancel'] as const) {
      await page.getByRole('button', { name: 'Start recording a voice command' }).click();
      await expect(stage(page).getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
      await page.waitForTimeout(400);
      await stage(page).getByRole('button', { name: how }).click();
      await expect(stage(page)).toHaveCount(0);
    }
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((t) => t.readyState))))
      .toEqual(['ended', 'ended']);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __contexts: AudioContext[] }).__contexts.map((c) => c.state))).toEqual(['closed', 'closed']);
    await page.waitForTimeout(500);
    expect(calls.transcribe).toBe(0);
    expect(calls.parse).toEqual([]);
    // Focus is back on the mic that opened it.
    await expect(page.getByRole('button', { name: 'Start recording a voice command' })).toBeFocused();
  });

  test('keyboard only: open the typed sheet, send with Enter, confirm with the keyboard; Escape closes', async ({ page }) => {
    await signIn(page, 'MANAGER');
    const calls = await stubVoice(page, { parse: [alexShoutout('Great job')] });

    const keyboard = page.getByRole('button', { name: 'Type a command' });
    await keyboard.focus();
    await page.keyboard.press('Enter');
    const s = stage(page);
    await expect(s.getByLabel("Type what you'd say")).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(stage(page)).toHaveCount(0);
    await expect(keyboard).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(s.getByLabel("Type what you'd say")).toBeFocused();
    await page.keyboard.type('Give Alex a shout-out saying great job');
    await page.keyboard.press('Enter');
    const sheet = confirmSheet(page, 'You typed');
    await expect(sheet.getByRole('status')).toHaveText('Ready to confirm');
    // Focus is on the sheet: Tab reaches Confirm first.
    await page.keyboard.press('Tab');
    await expect(sheet.getByRole('button', { name: 'Confirm' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.success-block')).toContainText('Done:');
    expect(calls.execute).toHaveLength(1);
  });

  test('closed while it reads the recording: the sheet steps aside and comes back with the answer', async ({ page }) => {
    await signIn(page, 'MANAGER');
    const heard = 'Give Alex a shout-out for the spotless bar';
    await stubVoice(page, { transcript: heard, transcribeDelayMs: 1500, parse: [{ body: { transcript: heard, intent: alexShoutout('Spotless bar'), voiceLogId: 'l', hasAdditionalRequest: false }, delayMs: 800 }] });
    await page.getByRole('button', { name: 'Start recording a voice command' }).click();
    await expect(stage(page).getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
    await page.waitForTimeout(500);
    await stage(page).getByRole('button', { name: 'Stop recording voice command' }).click({ force: true });
    await expect(page.getByRole('status').filter({ hasText: 'Transcribing…' })).toBeAttached();
    await stage(page).getByRole('button', { name: 'Close' }).click();
    await expect(stage(page)).toHaveCount(0);
    // The dock says it is still working.
    await expect(page.getByRole('button', { name: 'Processing voice command' })).toBeVisible();
    await expect(confirmSheet(page).getByText(`“${heard}”`)).toBeVisible();
  });

  test('50 open/close cycles: no animation frames left running and no memory growth', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, 'MANAGER');
    const cdp = await page.context().newCDPSession(page);
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    /** Animation-frame callbacks the page runs in one second. */
    const framesPerSecond = () =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let n = 0;
            const orig = window.requestAnimationFrame;
            window.requestAnimationFrame = (cb) => {
              n++;
              return orig.call(window, cb);
            };
            setTimeout(() => {
              window.requestAnimationFrame = orig;
              resolve(n);
            }, 1000);
          }),
      );
    const cycle = async (how: 'type' | 'mic') => {
      if (how === 'type') await page.getByRole('button', { name: 'Type a command' }).click();
      else await page.getByRole('button', { name: 'Start recording a voice command' }).click();
      await expect(stage(page).locator('canvas')).toBeVisible();
      await stage(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(stage(page)).toHaveCount(0);
    };
    for (let i = 0; i < 5; i++) await cycle(i % 2 ? 'mic' : 'type');
    const idleFrames = await framesPerSecond();
    const before = await heap();
    for (let i = 0; i < 50; i++) await cycle(i % 2 ? 'mic' : 'type');
    const after = await heap();
    expect(await framesPerSecond()).toBeLessThanOrEqual(idleFrames + 2);
    expect(after - before, `heap ${before} → ${after}`).toBeLessThan(3 * 1024 * 1024);
    const note = `${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB after 50 cycles; idle frames/s ${idleFrames}`;
    test.info().annotations.push({ type: 'heap', description: note });
    console.log(`[voice-sheet] heap ${note}`);
  });
});
