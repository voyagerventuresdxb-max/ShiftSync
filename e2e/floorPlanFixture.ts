import { expect, type CDPSession, type Page } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Shared floor-plan fixtures for the floor-plan specs: the 8 Bar des Prés
 * sections and real multi-touch helpers.
 *
 * The 8 Bar des Prés sections are traced as irregular polygons (fractional
 * coords over the venue's 16:9 plan). e2e/fixtures/floor-plan.png has the
 * same 16:9 aspect, so the rendered geometry at 390px is identical to the
 * real 1440x810 plan.
 */

const API = 'http://localhost:4000';

export const BAR_DES_PRES_SECTIONS = [
  { label: 'Section 1', paxCapacity: 18, notes: 'Shade after 17:00', polygon: [{ x: 0.03, y: 0.36 }, { x: 0.12, y: 0.30 }, { x: 0.16, y: 0.42 }, { x: 0.10, y: 0.66 }, { x: 0.03, y: 0.62 }] },
  { label: 'Section 2', paxCapacity: 16, polygon: [{ x: 0.13, y: 0.22 }, { x: 0.29, y: 0.20 }, { x: 0.30, y: 0.40 }, { x: 0.15, y: 0.42 }] },
  { label: 'Section 3', paxCapacity: 15, polygon: [{ x: 0.16, y: 0.44 }, { x: 0.35, y: 0.44 }, { x: 0.35, y: 0.55 }, { x: 0.20, y: 0.56 }] },
  { label: 'Section 4', paxCapacity: 15, polygon: [{ x: 0.30, y: 0.22 }, { x: 0.48, y: 0.30 }, { x: 0.49, y: 0.44 }, { x: 0.31, y: 0.42 }] },
  { label: 'Section 5', paxCapacity: 15, polygon: [{ x: 0.49, y: 0.30 }, { x: 0.63, y: 0.30 }, { x: 0.71, y: 0.38 }, { x: 0.62, y: 0.44 }, { x: 0.50, y: 0.44 }] },
  { label: 'Section 6', paxCapacity: 16, polygon: [{ x: 0.71, y: 0.24 }, { x: 0.91, y: 0.22 }, { x: 0.93, y: 0.34 }, { x: 0.73, y: 0.36 }] },
  { label: 'Section 7', paxCapacity: 16, polygon: [{ x: 0.88, y: 0.36 }, { x: 0.97, y: 0.36 }, { x: 0.97, y: 0.66 }, { x: 0.86, y: 0.64 }] },
  { label: 'Section 8', paxCapacity: 14, polygon: [{ x: 0.73, y: 0.38 }, { x: 0.86, y: 0.38 }, { x: 0.87, y: 0.52 }, { x: 0.73, y: 0.54 }] },
];

export async function sessionFromPage(page: Page): Promise<{ token: string; locationId: string }> {
  const raw = await page.evaluate(() => localStorage.getItem('shiftsync.session'));
  const session = JSON.parse(raw ?? 'null') as { token: string; user: { locationId: string } };
  return { token: session.token, locationId: session.user.locationId };
}

/** Uploads the plan image and the 8 Bar des Prés sections through the real API with the signed-in session. */
export async function seedBarDesPres(page: Page): Promise<void> {
  const { token, locationId } = await sessionFromPage(page);
  const auth = { Authorization: `Bearer ${token}` };
  const fd = new FormData();
  fd.append('locationId', locationId);
  fd.append('file', new Blob([readFileSync(path.resolve('e2e/fixtures/floor-plan.png'))], { type: 'image/png' }), 'floor-plan.png');
  const up = await fetch(`${API}/api/floor-plan/upload`, { method: 'POST', headers: auth, body: fd });
  expect(up.ok, 'floor plan upload').toBeTruthy();
  const { image } = (await up.json()) as { image: { id: string } };
  for (const s of BAR_DES_PRES_SECTIONS) {
    const res = await fetch(`${API}/api/floor-plan/sections`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, floorPlanImageId: image.id, ...s }),
    });
    expect(res.ok, `create ${s.label}`).toBeTruthy();
  }
}

/**
 * Real multi-touch through Chrome DevTools Protocol — Playwright's
 * touchscreen API is single-tap only. Each call dispatches genuine touch
 * events, so the page sees real pointer events with distinct pointerIds.
 */
export class Touch {
  private constructor(private readonly client: CDPSession) {}

  static async open(page: Page): Promise<Touch> {
    return new Touch(await page.context().newCDPSession(page));
  }

  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number }>): Promise<void> {
    await this.client.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
  }

  /** Two fingers, horizontally apart by `fromGap` → `toGap`, midpoint moving from `from` to `to`. */
  async pinch(from: { x: number; y: number }, fromGap: number, toGap: number, to = from, steps = 12): Promise<void> {
    const at = (t: number) => {
      const gap = fromGap + (toGap - fromGap) * t;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      return [{ x: x - gap / 2, y }, { x: x + gap / 2, y }];
    };
    await this.send('touchStart', at(0));
    for (let i = 1; i <= steps; i++) await this.send('touchMove', at(i / steps));
    await this.send('touchEnd', []);
  }

  /**
   * One finger from `a` to `b`, settling for a moment before lifting. A
   * release at full speed makes Chrome start a fling, and the NEXT tap is
   * then consumed as "stop the fling" (no click) — native platform
   * behaviour, same as tapping during a scroll fling — which would make a
   * following tap assertion flaky rather than test the app.
   */
  async drag(a: { x: number; y: number }, b: { x: number; y: number }, steps = 12): Promise<void> {
    await this.send('touchStart', [a]);
    for (let i = 1; i <= steps; i++) await this.send('touchMove', [{ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }]);
    await new Promise((r) => setTimeout(r, 150));
    await this.send('touchMove', [b]);
    await this.send('touchEnd', []);
  }
}

/** The plan viewport's current zoom scale (PlanZoomViewport exposes it as data-plan-zoom). */
export async function planZoom(page: Page): Promise<number> {
  return Number(await page.locator('.fp-canvas-wrap').getAttribute('data-plan-zoom'));
}

/** Screen position of a plan-space fraction (0–1) under the current zoom/pan, via the zoom layer's own box. */
export async function planPointOnScreen(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const layer = (await page.locator('.fp-canvas-wrap > div').first().boundingBox())!;
  return { x: layer.x + fx * layer.width, y: layer.y + fy * layer.height };
}
