import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { cleanupTestOrgs, nextEchoPhone, prisma, signupNewVenue, testVenueName } from './helpers';
import { EXCLUDED_SELECTORS, TOUCH_TARGET_EXCEPTIONS } from './touch-targets.allowlist';

/**
 * Permanent touch-target regression gate (2026-09-28, mobile-first pass).
 *
 * At a 390x844 touch viewport, on a defined list of key routes and sheets,
 * every interactive element must have an EFFECTIVE hit area of at least
 * 44x44 CSS px — its own box, or its box plus the invisible `hit-44`
 * ::after expansion (src/styles/tailwind.css) — and a tap at each edge of
 * that area must land on the element (or one of its children), i.e. the
 * expansion is not clipped by an overflow ancestor or covered by a
 * neighbour. Documented exceptions (category b/c from the audit) live in
 * touch-targets.allowlist.ts with a one-line reason each.
 *
 * Real backend, real DB, real sessions: the manager session comes from the
 * actual onboarding signup; the staff session from the real /login
 * (phone + dev OTP echo), the same way a real staff member signs in.
 */

const MIN = 44;
const EDGE_INSET = 2; // px inside the expanded box where a tap must still land on the element (2, not 1: a 1px border sits exactly on the pseudo's edge)
const FIXTURE_PNG = path.resolve('e2e/fixtures/floor-plan.png');
const API = 'http://localhost:4000';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

interface Measured {
  label: string;
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  effW: number;
  effH: number;
  /** Fraction (0–1) of edge probe points that resolved to the element or a descendant. */
  edgeHits: number;
  edgeMisses: string[];
  covered: boolean;
}

/** Runs in the page: measures every reachable interactive element's visual + effective box and probes the expanded area's edges with elementFromPoint. */
async function measurePage(page: Page, excluded: string[]): Promise<Measured[]> {
  return page.evaluate(
    ({ EDGE_INSET, excluded }) => {
      const SEL =
        'button, a[href], input:not([type=hidden]), select, textarea, summary, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="link"], [role="menuitem"], [tabindex="0"]';
      const px = (v: string) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      };
      const labelOf = (el: Element): string => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria;
        const ph = el.getAttribute('placeholder');
        if (ph) return `input:${ph}`;
        if (el.tagName === 'INPUT') return `input[${el.getAttribute('type') || 'text'}]`;
        const txt = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return txt ? txt.slice(0, 60) : el.tagName.toLowerCase();
      };
      const out: Measured[] = [];
      const all = Array.from(document.querySelectorAll(SEL)).filter((el) => !excluded.some((s) => el.matches(s) || el.closest(s)));
      const rects = new Map<Element, DOMRect>();
      for (const el of all) rects.set(el, el.getBoundingClientRect());
      for (const el of all) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || (el as HTMLElement).hidden || cs.pointerEvents === 'none' || px(cs.opacity) === 0) continue;
        const r = rects.get(el)!;
        if (r.width === 0 || r.height === 0) continue;
        // effective box = visual box ∪ ::after expansion (hit-44 sets px insets)
        let eff = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        let expanded = false;
        const after = getComputedStyle(el, '::after');
        if (after.content !== 'none' && after.content !== 'normal' && after.position === 'absolute' && after.pointerEvents !== 'none' && after.top !== 'auto' && after.left !== 'auto' && after.right !== 'auto' && after.bottom !== 'auto') {
          const pb = { left: r.left + px(after.left), top: r.top + px(after.top), right: r.right - px(after.right), bottom: r.bottom - px(after.bottom) };
          eff = { left: Math.min(eff.left, pb.left), top: Math.min(eff.top, pb.top), right: Math.max(eff.right, pb.right), bottom: Math.max(eff.bottom, pb.bottom) };
          expanded = pb.left < r.left || pb.top < r.top || pb.right > r.right || pb.bottom > r.bottom;
        }
        // Probe the expanded area's edges — only meaningful once it is ≥ MIN; the
        // element must be in the viewport for elementFromPoint, so scroll it
        // to the centre and restore every scroll position afterwards.
        const saved: Array<[Element, number, number]> = [];
        for (let a = el.parentElement; a; a = a.parentElement) saved.push([a, a.scrollLeft, a.scrollTop]);
        const sx = window.scrollX;
        const sy = window.scrollY;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rr = el.getBoundingClientRect();
        const dx = rr.left - r.left;
        const dy = rr.top - r.top;
        const box = { left: eff.left + dx, top: eff.top + dy, right: eff.right + dx, bottom: eff.bottom + dy };
        const cx = (box.left + box.right) / 2;
        const cy = (box.top + box.bottom) / 2;
        // Edge midpoints always; corners only when a (square) ::after expansion
        // exists — a rounded element that is already ≥44px has no element at
        // the 1px corner of its own box, and that is fine.
        const probes: Array<[string, number, number]> = [
          ['centre', cx, cy],
          ['left', box.left + EDGE_INSET, cy],
          ['right', box.right - EDGE_INSET, cy],
          ['top', cx, box.top + EDGE_INSET],
          ['bottom', cx, box.bottom - EDGE_INSET],
        ];
        if (expanded) {
          probes.push(
            ['top-left', box.left + EDGE_INSET, box.top + EDGE_INSET],
            ['top-right', box.right - EDGE_INSET, box.top + EDGE_INSET],
            ['bottom-left', box.left + EDGE_INSET, box.bottom - EDGE_INSET],
            ['bottom-right', box.right - EDGE_INSET, box.bottom - EDGE_INSET],
          );
        }
        let hits = 0;
        const misses: string[] = [];
        let covered = false;
        for (const [name, x, y] of probes) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
            hits++; // off-viewport corner (e.g. a full-width bar): not probe-able, don't penalise
            continue;
          }
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === el || el.contains(hit))) hits++;
          else {
            misses.push(`${name}→${hit ? hit.tagName.toLowerCase() + (hit.getAttribute('aria-label') ? `[${hit.getAttribute('aria-label')}]` : '') : 'null'}`);
            if (name === 'centre') covered = true;
          }
        }
        for (const [n, l, t] of saved) {
          if (n.scrollLeft !== l) n.scrollLeft = l;
          if (n.scrollTop !== t) n.scrollTop = t;
        }
        window.scrollTo(sx, sy);
        out.push({
          label: labelOf(el),
          tag: el.tagName.toLowerCase(),
          x: r.left,
          y: r.top,
          w: r.width,
          h: r.height,
          effW: eff.right - eff.left,
          effH: eff.bottom - eff.top,
          edgeHits: hits / probes.length,
          edgeMisses: misses,
          covered,
        });
      }
      return out;
    },
    { EDGE_INSET, excluded },
  );
}

function isAllowlisted(m: Measured, pathname: string): boolean {
  return TOUCH_TARGET_EXCEPTIONS.some((e) => e.label.test(m.label) && (!e.tag || e.tag === m.tag) && (!e.route || pathname.startsWith(e.route)));
}

/** Asserts every non-allowlisted, reachable target on the current page meets the rule. */
async function assertTouchTargets(page: Page, screen: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
  // Entrance transitions (the onboarding screens animate each section with
  // transform/opacity, which creates stacking contexts while they run) must
  // finish before elementFromPoint means anything — measure at rest.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a as CSSAnimation).animationName !== undefined && /breathe|spin|ob-chevron|ob-/.test((a as CSSAnimation).animationName ?? '')), undefined, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(200);
  const pathname = new URL(page.url()).pathname;
  const items = (await measurePage(page, EXCLUDED_SELECTORS)).filter((m) => !m.covered && !isAllowlisted(m, pathname));
  expect(items.length, `${screen}: no interactive elements measured — the screen probably did not render`).toBeGreaterThan(0);
  const failures: string[] = [];
  for (const m of items) {
    const sizeOk = m.effW >= MIN - 0.5 && m.effH >= MIN - 0.5;
    const edgesOk = m.edgeHits === 1;
    if (!sizeOk || !edgesOk) {
      failures.push(
        `${screen} › "${m.label}" <${m.tag}> visual ${m.w.toFixed(0)}x${m.h.toFixed(0)} effective ${m.effW.toFixed(0)}x${m.effH.toFixed(0)}${edgesOk ? '' : ` edge misses: ${m.edgeMisses.join(', ')}`}`,
      );
    }
  }
  expect(failures, `${failures.length} touch-target failure(s):\n${failures.join('\n')}`).toEqual([]);
}

/** Reads the real session the UI stored after signup, for seeding via the API. */
async function sessionToken(page: Page): Promise<{ token: string; locationId: string; userId: string }> {
  const raw = await page.evaluate(() => localStorage.getItem('shiftsync.session'));
  const s = JSON.parse(raw ?? 'null') as { token: string; user: { locationId: string; id: string } } | null;
  if (!s) throw new Error('no session in localStorage');
  return { token: s.token, locationId: s.user.locationId, userId: s.user.id };
}

async function api(token: string, method: string, route: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Seeds a floor plan + two sections + roles/shifts so the floor-plan and rota screens render their real rows. */
async function seedVenueContent(page: Page): Promise<{ staffPhone: string }> {
  const { token, locationId } = await sessionToken(page);
  const fd = new FormData();
  fd.append('locationId', locationId);
  fd.append('file', new Blob([readFileSync(FIXTURE_PNG)], { type: 'image/png' }), 'floor-plan.png');
  const up = await fetch(`${API}/api/floor-plan/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  expect(up.ok, 'floor plan upload').toBeTruthy();
  const { image } = (await up.json()) as { image: { id: string } };
  await api(token, 'POST', '/api/floor-plan/sections', {
    locationId,
    floorPlanImageId: image.id,
    label: 'Area 1',
    paxCapacity: 12,
    pinX: 0.185,
    pinY: 0.265,
  });
  await api(token, 'POST', '/api/floor-plan/sections', {
    locationId,
    floorPlanImageId: image.id,
    label: 'Area 5',
    paxCapacity: 10,
    pinX: 0.515,
    pinY: 0.735,
  });
  // A real staff member (with a phone, so they can log in through /login).
  const staffPhone = nextEchoPhone();
  const role = await prisma.role.findFirst({ where: { locationId } });
  const staff = await prisma.user.create({
    data: { locationId, systemRole: 'STAFF', fullName: 'E2E Staff Member', jobTitle: 'Waiter', phone: staffPhone, roleId: role?.id ?? null },
  });
  // One shift this week (RotaBuilder chip + Personal Rota card).
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (role) await api(token, 'POST', '/api/shifts', { roleId: role.id, userId: staff.id, date: iso, start: '10:00', end: '15:00' });
  return { staffPhone };
}

test.describe('touch targets — every interactive element has a ≥44x44 effective hit area', () => {
  test.afterEach(async ({ page }) => {
    await page.close().catch(() => {});
    await cleanupTestOrgs();
  });

  test('manager routes, sheets and onboarding steps', async ({ page }) => {
    test.setTimeout(240_000);
    await signupNewVenue(page, testVenueName('touch-targets'));
    await page.waitForSelector('text=Tell us about the room.');
    await assertTouchTargets(page, 'Onboarding › Venue');
    await page.getByRole('button', { name: 'Dubai' }).click();
    await page.getByRole('button', { name: 'Fine Dining' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/onboarding/roster**');
    await assertTouchTargets(page, 'Onboarding › Roster');

    await seedVenueContent(page);

    await page.goto('/');
    await page.waitForSelector('text=Direct Floor Feedback');
    await assertTouchTargets(page, 'Home');
    await page.getByRole('button', { name: /notifications/i }).first().click();
    await page.waitForSelector('text=Notifications');
    await assertTouchTargets(page, 'Home › NotificationBell open');

    await page.goto('/scheduling');
    await page.waitForSelector('text=Weekly rota builder');
    await assertTouchTargets(page, 'Scheduling');
    await page.getByRole('button', { name: /Save as template/ }).first().click();
    await page.waitForSelector('text=Save week as template');
    await assertTouchTargets(page, 'Scheduling › RotaBuilder sheet');
    await page.getByRole('button', { name: 'Close' }).first().click();

    await page.goto('/floor-plan');
    await page.waitForSelector('.fp-canvas-wrap img');
    await assertTouchTargets(page, 'Floor plan › Daily Assignment');
    await page.getByRole('button', { name: /^Area 1,/ }).click();
    await page.waitForSelector('text=pax assigned');
    await assertTouchTargets(page, 'Floor plan › SectionDetail');
    await page.getByRole('button', { name: 'Assign staff' }).click();
    await page.waitForSelector('text=Assign to Area 1');
    await assertTouchTargets(page, 'Floor plan › SectionPicker');
    await page.getByRole('button', { name: 'Close' }).first().click();

    await page.goto('/people');
    await page.waitForSelector('text=Staff Directory');
    await assertTouchTargets(page, 'People');

    await page.goto('/profile');
    await page.waitForSelector('text=Sign out');
    await assertTouchTargets(page, 'Profile');

    await page.goto('/my-shifts');
    await page.waitForSelector('text=Tap to change', { timeout: 15000 }).catch(() => {});
    await assertTouchTargets(page, 'My Shifts');
  });

  test('staff session — real /login', async ({ page }) => {
    test.setTimeout(240_000);
    await signupNewVenue(page, testVenueName('touch-targets-staff'));
    await page.waitForSelector('text=Tell us about the room.');
    const { staffPhone } = await seedVenueContent(page);

    // Sign out of the manager session and log in as the staff member through the real UI.
    await page.evaluate(() => localStorage.removeItem('shiftsync.session'));
    await page.goto('/login');
    await page.getByPlaceholder('Phone number').fill(staffPhone);
    await page.getByRole('button', { name: 'Send code' }).click();
    // /login prints the echoed dev OTP inline ("Dev mode — your code is 123456 …").
    const devCode = (await page.locator('p.hint .font-mono').innerText()).trim();
    await page.getByPlaceholder('6-digit code').fill(devCode);
    await page.getByRole('button', { name: /Verify & log in/ }).click();
    await page.waitForURL('**/my-shifts**');

    await assertTouchTargets(page, 'staff › My Shifts');
    await page.goto('/scheduling');
    await page.waitForSelector('text=Personal Rota');
    await assertTouchTargets(page, 'staff › Scheduling');
    await page.goto('/floor-plan');
    await page.waitForSelector('.fp-canvas-wrap img');
    await assertTouchTargets(page, 'staff › Floor plan');
    await page.getByRole('button', { name: /^Area 1,/ }).click();
    await page.waitForSelector('text=pax assigned');
    await assertTouchTargets(page, 'staff › SectionDetail (read-only)');
    await page.goto('/people');
    await page.waitForSelector('text=Staff Directory');
    await assertTouchTargets(page, 'staff › People');
  });
});
