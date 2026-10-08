import { expect, type Page, type Route } from '@playwright/test';
import type { SystemRole } from '@prisma/client';
import { nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Shared by the voice bug-hunt specs: a real sign-in (dev OTP echo) and every /api/voice/* call
 * stubbed (no model, no key). Names are made up.
 */

export const usedPhones: string[] = [];

export async function signIn(page: Page, systemRole: SystemRole, label = 'voice-hunt'): Promise<{ userId: string; locationId: string }> {
  const org = await prisma.organization.create({ data: { name: testVenueName(`${label}-${systemRole.toLowerCase()}`) } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const phone = nextEchoPhone();
  usedPhones.push(phone);
  const user = await prisma.user.create({ data: { locationId: location.id, systemRole, fullName: `E2E Voice Hunt ${systemRole}`, phone } });
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
  await page.evaluate((id) => localStorage.setItem(`shiftsync.voiceConsent.${id}`, '1'), user.id);
  return { userId: user.id, locationId: location.id };
}

export interface Calls {
  parse: { transcript: string; source?: string }[];
  execute: { transcript?: string; intent: Record<string, unknown>; voiceLogId?: string | null }[];
  transcribe: number;
}
export type Reply = { status?: number; body: unknown; delayMs?: number };

/** Stubs the three voice endpoints; `transcript` may be a list (one per recording, the last repeats). */
export async function stubVoice(
  page: Page,
  {
    parse = [],
    execute = [{ body: { executed: true, result: {} } }],
    transcript = '',
    transcribeDelayMs = 300,
  }: { parse?: (Reply | Record<string, unknown>)[]; execute?: Reply[]; transcript?: string | string[]; transcribeDelayMs?: number } = {},
): Promise<Calls> {
  const calls: Calls = { parse: [], execute: [], transcribe: 0 };
  const transcripts = Array.isArray(transcript) ? transcript : [transcript];
  const fulfil = async (route: Route, reply: Reply) => {
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body) }).catch(() => {});
  };
  await page.route('**/api/voice/transcribe', async (route) => {
    const n = calls.transcribe++;
    await fulfil(route, { body: { transcript: transcripts[Math.min(n, transcripts.length - 1)] }, delayMs: transcribeDelayMs });
  });
  await page.route('**/api/voice/parse-intent', async (route) => {
    const body = route.request().postDataJSON() as { transcript: string; source?: string };
    calls.parse.push(body);
    const next = parse[Math.min(calls.parse.length - 1, parse.length - 1)];
    if (!next) throw new Error('No parse-intent answer stubbed');
    const reply: Reply = 'body' in next ? (next as Reply) : { body: { transcript: body.transcript, intent: next, voiceLogId: `log-${calls.parse.length}`, hasAdditionalRequest: false } };
    await fulfil(route, reply);
  });
  await page.route('**/api/voice/execute', async (route) => {
    calls.execute.push(route.request().postDataJSON() as Calls['execute'][number]);
    await fulfil(route, execute[Math.min(calls.execute.length - 1, execute.length - 1)]!);
  });
  return calls;
}

/** The full-height voice sheet while it is on top. */
export const stage = (page: Page) => page.locator('.voice-stage > [role="dialog"]');
/** The confirm sheet: the one dialog showing what was heard or typed. */
export const confirmSheet = (page: Page, origin: 'I heard' | 'You typed' = 'I heard') => page.getByRole('dialog').filter({ hasText: origin });

export async function startRecording(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start recording a voice command' }).click();
  await expect(stage(page).getByRole('button', { name: 'Stop recording voice command' })).toBeVisible();
}

export async function record(page: Page): Promise<void> {
  await startRecording(page);
  await page.waitForTimeout(600);
  // The recording ring animates, so the button never passes Playwright's stability check.
  await stage(page).getByRole('button', { name: 'Stop recording voice command' }).click({ force: true });
}

/** Keeps every microphone stream the page opens, so a test can check each was released. */
export async function trackMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c);
      w.__streams.push(s);
      return s;
    };
  });
}

export const micTracks = (page: Page) => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((t) => t.readyState)));

/** The page going to the background (an iPhone app switch or a locked screen) and coming back. */
export async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

export const alexShoutout = (note: string) => ({
  intent: 'POST_SHOUTOUT',
  targetUserId: 'user-alex',
  targetUserName: 'Alex Example',
  content: note,
  confidence: 0.95,
  summary: 'Give Alex Example a shout-out with this note.',
  details: { person: 'Alex Example', personRole: 'Bartender' },
});
