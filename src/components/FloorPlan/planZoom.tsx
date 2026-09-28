import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Minimize2 } from 'lucide-react';

/**
 * Pinch-to-zoom + pan for the floor plan (2026-09-29). No gesture library:
 * plain pointer events on the plan's viewport element.
 *
 * Coordinate system — read this before touching anything that maps a point
 * on the plan:
 *  - "plan space" is the un-zoomed layout: the plan fills the viewport at
 *    scale 1, so plan space == viewport CSS px at 1x. Section polygons are
 *    stored as fractions of it (0–1), exactly as before zoom existed.
 *  - The view is `translate(x, y) scale(scale)` with origin top-left:
 *    screen = viewportOrigin + (x, y) + planPoint * scale.
 *    planPoint = (screen - viewportOrigin - (x, y)) / scale.
 *  - Daily Assignment applies the view as a CSS transform on one layer
 *    (`PlanZoomViewport`); dnd-kit measures drop targets with
 *    getBoundingClientRect, which already includes CSS transforms, so drops
 *    map to the right section with no extra maths.
 *  - The Konva setup editor applies the same view as Stage scale/position and
 *    reads points with `getRelativePointerPosition()` (plan space), never
 *    `getPointerPosition()` (screen space).
 *
 * Gestures: two fingers pinch (and pan by moving their midpoint); one
 * finger/mouse drags to pan once zoomed in (a move under TAP_SLOP is still a
 * tap, so tapping a pin/section keeps working — and a tap that ended a pan
 * is swallowed); ctrl+wheel / trackpad pinch zooms on desktop; double-tap on
 * empty plan resets; the Reset button always resets. At 1x, one finger is
 * left to the browser (`touch-action: pan-y`) so the page still scrolls.
 * Zoom state is per-mount React state: it resets on every visit (decided
 * 2026-09-29, see Decisions.md).
 */

export interface PlanView {
  scale: number;
  x: number;
  y: number;
}

export const PLAN_MIN_SCALE = 1; // fit-to-viewport: never zoom out past the whole plan
export const PLAN_MAX_SCALE = 3;
const IDENTITY: PlanView = { scale: 1, x: 0, y: 0 };
const TAP_SLOP = 8; // px a pointer may move and still count as a tap
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;

function clampView(v: PlanView, w: number, h: number): PlanView {
  const scale = Math.min(PLAN_MAX_SCALE, Math.max(PLAN_MIN_SCALE, v.scale));
  return {
    scale,
    x: Math.min(0, Math.max(w - w * scale, v.x)),
    y: Math.min(0, Math.max(h - h * scale, v.y)),
  };
}

interface Point {
  x: number;
  y: number;
}

export interface PlanZoom {
  view: PlanView;
  reset: () => void;
  /** True while/after a gesture that pinched or panned — callers that act on a tap (Konva's click/tap) must ignore it. Cleared when the next gesture starts. */
  gestureConsumedTap: () => boolean;
}

/**
 * Attaches the zoom/pan gestures to `viewportRef`. `oneFingerGestures`
 * (default true) enables one-finger pan and double-tap reset; the editor
 * turns it off while drawing, where one finger places points.
 */
export function usePlanZoom(viewportRef: RefObject<HTMLElement | null>, { oneFingerGestures = true } = {}): PlanZoom {
  const [view, setView] = useState<PlanView>(IDENTITY);
  const viewRef = useRef(view);
  viewRef.current = view;
  const oneFingerRef = useRef(oneFingerGestures);
  oneFingerRef.current = oneFingerGestures;
  const g = useRef({
    pointers: new Map<number, Point>(),
    starts: new Map<number, Point>(),
    start: IDENTITY,
    moved: false,
    multi: false,
    suppressClick: false,
    lastTap: null as { t: number; x: number; y: number } | null,
  }).current;

  const reset = useCallback(() => setView(IDENTITY), []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }): Point => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left - el.clientLeft, y: e.clientY - r.top - el.clientTop };
    };
    const rebase = () => {
      g.start = viewRef.current;
      g.starts = new Map(g.pointers);
    };
    const apply = (v: PlanView) => setView(clampView(v, el.clientWidth, el.clientHeight));
    const capture = (id: number) => {
      try {
        el.setPointerCapture(id);
      } catch {
        /* pointer already gone */
      }
    };

    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-plan-zoom-control]')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (g.pointers.size === 0) {
        g.moved = false;
        g.multi = false;
        // A touch pan fires no click at all, so a pending suppression must
        // not outlive its gesture and swallow the next real tap.
        g.suppressClick = false;
      }
      g.pointers.set(e.pointerId, local(e));
      if (g.pointers.size > 1) g.multi = true;
      rebase();
    };

    const onMove = (e: PointerEvent) => {
      if (!g.pointers.has(e.pointerId)) return;
      g.pointers.set(e.pointerId, local(e));
      const ids = [...g.pointers.keys()];
      if (ids.length >= 2) {
        const [a, b] = [g.pointers.get(ids[0]!)!, g.pointers.get(ids[1]!)!];
        const [a0, b0] = [g.starts.get(ids[0]!)!, g.starts.get(ids[1]!)!];
        const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
        const s0 = g.start.scale;
        const scale = Math.min(PLAN_MAX_SCALE, Math.max(PLAN_MIN_SCALE, (s0 * Math.hypot(b.x - a.x, b.y - a.y)) / d0));
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
        // Keep the plan point that was under the starting midpoint under the current midpoint.
        const px = (m0.x - g.start.x) / s0;
        const py = (m0.y - g.start.y) / s0;
        g.moved = true;
        ids.forEach(capture);
        apply({ scale, x: m.x - px * scale, y: m.y - py * scale });
        return;
      }
      const p = g.pointers.get(e.pointerId)!;
      const p0 = g.starts.get(e.pointerId)!;
      const dx = p.x - p0.x;
      const dy = p.y - p0.y;
      if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      if (!oneFingerRef.current || g.start.scale <= PLAN_MIN_SCALE) return;
      g.moved = true;
      capture(e.pointerId);
      apply({ ...g.start, x: g.start.x + dx, y: g.start.y + dy });
    };

    const onUp = (e: PointerEvent) => {
      if (!g.pointers.has(e.pointerId)) return;
      const p = local(e);
      g.pointers.delete(e.pointerId);
      if (g.pointers.size > 0) {
        rebase(); // pinch → one finger left: keep panning from where we are
        return;
      }
      if (g.moved || g.multi) {
        if (g.moved) g.suppressClick = true;
        g.lastTap = null;
        return;
      }
      // A plain tap. Two on empty plan (not on a section/pin/button) = reset.
      if (e.type === 'pointercancel' || !oneFingerRef.current) return;
      if ((e.target as Element | null)?.closest?.('[role="button"], button')) {
        g.lastTap = null;
        return;
      }
      const now = performance.now();
      const last = g.lastTap;
      if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(p.x - last.x, p.y - last.y) < DOUBLE_TAP_SLOP) {
        g.lastTap = null;
        setView(IDENTITY);
      } else {
        g.lastTap = { t: now, x: p.x, y: p.y };
      }
    };

    // The click that ends a pan must not open the section it started on.
    const onClickCapture = (e: MouseEvent) => {
      if (!g.suppressClick) return;
      g.suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    };

    // Desktop: ctrl+wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms about the cursor.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const v = viewRef.current;
      const p = local(e);
      const scale = Math.min(PLAN_MAX_SCALE, Math.max(PLAN_MIN_SCALE, v.scale * Math.exp(-e.deltaY * 0.01)));
      apply({ scale, x: p.x - ((p.x - v.x) / v.scale) * scale, y: p.y - ((p.y - v.y) / v.scale) * scale });
    };

    // A width change (rotation, resize) changes plan space itself: start over at fit.
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        setView(IDENTITY);
      }
    });

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('click', onClickCapture, true);
    el.addEventListener('wheel', onWheel, { passive: false });
    observer.observe(el);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('click', onClickCapture, true);
      el.removeEventListener('wheel', onWheel);
      observer.disconnect();
    };
  }, [viewportRef, g]);

  const gestureConsumedTap = useCallback(() => g.moved || g.multi, [g]);
  return { view, reset, gestureConsumedTap };
}

/** `touch-action` for a plan viewport: let the page scroll at 1x, take every touch once zoomed in. */
export function planTouchAction(view: PlanView): 'pan-y' | 'none' {
  return view.scale > PLAN_MIN_SCALE ? 'none' : 'pan-y';
}

const PlanViewContext = createContext<PlanView>(IDENTITY);

/** The current zoom/pan of the enclosing `PlanZoomViewport` (identity outside one). */
export function usePlanView(): PlanView {
  return useContext(PlanViewContext);
}

/** Small bottom-corner "reset zoom" control, shown only while zoomed in. */
export function ResetZoomButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-plan-zoom-control
      onClick={onClick}
      aria-label="Reset zoom"
      className="hit-44 absolute bottom-2 right-2 z-[2] grid h-8 w-8 place-items-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
    >
      <Minimize2 className="h-4 w-4" />
    </button>
  );
}

/**
 * The Daily Assignment plan viewport: `className` (normally `fp-canvas-wrap`)
 * is the clipping viewport; children (the plan image + section overlays) sit
 * on one zoom layer. At rest (1x) the layer carries no transform at all, so
 * the unzoomed plan renders exactly as it did before zoom existed.
 */
export function PlanZoomViewport({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { view, reset } = usePlanZoom(ref);
  const zoomed = view.scale > PLAN_MIN_SCALE || view.x !== 0 || view.y !== 0;
  return (
    <div ref={ref} className={className} data-plan-zoom={view.scale.toFixed(3)} style={{ touchAction: planTouchAction(view) }}>
      <div
        className="relative"
        style={zoomed ? { transformOrigin: '0 0', transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } : undefined}
      >
        <PlanViewContext.Provider value={view}>{children}</PlanViewContext.Provider>
      </div>
      {zoomed && <ResetZoomButton onClick={reset} />}
    </div>
  );
}
