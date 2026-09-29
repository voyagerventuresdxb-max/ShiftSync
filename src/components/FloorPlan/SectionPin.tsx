import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes, type Ref, type RefObject } from 'react';
import { MapPin, StickyNote } from 'lucide-react';
import { cn } from '../../lib/utils';
import { sectionPinName } from './staffFormat';
import { usePlanView, type PlanView } from './planZoom';

/**
 * Neither the notes field nor the server route caps note length — fine for
 * `SectionDetail.tsx`'s full-detail view, but a pin's tooltip and aria-label
 * are a compact, glanceable surface, not a place for an unbounded
 * multi-sentence note to dump verbatim. The full text is one tap away.
 *
 * Segments by grapheme cluster (`Intl.Segmenter`), not by `.slice`'s raw
 * UTF-16 code units — a plain `.slice(0, 80)` can cut an astral-plane emoji
 * in half or split a combining-mark/ZWJ sequence (a flag, a family emoji,
 * Arabic diacritics — all plausible in this app's Dubai/GCC hospitality
 * context). Falls back to the code-unit slice only if it's unavailable.
 */
export function truncateNote(note: string, maxLength = 80): string {
  if (note.length <= maxLength) return note;
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter === 'undefined') {
    return `${note.slice(0, maxLength - 1).trimEnd()}…`;
  }
  const graphemes = Array.from(new Intl.Segmenter().segment(note), (s) => s.segment);
  if (graphemes.length <= maxLength) return note;
  return `${graphemes.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

/**
 * Nudges the pin (in px, on top of its anchoring) so it never renders past
 * the plan's clipping box (`.fp-canvas-wrap` is overflow: hidden) — a pin
 * dropped at the edge of the plan would otherwise be cut off. Zero for every
 * pin that already fits, so those don't move.
 *
 * Zoom-aware (see planZoom.tsx): the nudge is applied inside the zoom layer,
 * so it moves the pin by `nudge * scale` on screen — measured in screen px,
 * stored divided by the scale. The clip box is the visible viewport; a pin
 * whose anchor is panned out of view is left where it is (clipped away)
 * rather than dragged to the viewport edge. At 1x the anchor is always
 * inside the plan.
 */
function useKeepInsidePlan(pinRef: RefObject<HTMLDivElement | null>, view: PlanView, anchor: { x: number; y: number }): { x: number; y: number } {
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;
  const scaleRef = useRef(view.scale);
  scaleRef.current = view.scale;
  const updateRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const pin = pinRef.current;
    const plan = pin?.closest('.fp-canvas-wrap');
    if (!pin || !plan) return;
    const update = () => {
      const p = pin.getBoundingClientRect();
      const w = plan.getBoundingClientRect();
      const inner = { left: w.left + plan.clientLeft, top: w.top + plan.clientTop };
      const bounds = { ...inner, right: inner.left + plan.clientWidth, bottom: inner.top + plan.clientHeight };
      const { x: nx, y: ny } = nudgeRef.current;
      const z = scaleRef.current;
      const base = { left: p.left - nx * z, right: p.right - nx * z, top: p.top - ny * z, bottom: p.bottom - ny * z };
      const ax = (base.left + base.right) / 2;
      const ay = (base.top + base.bottom) / 2;
      const anchorVisible = ax >= bounds.left && ax <= bounds.right && ay >= bounds.top && ay <= bounds.bottom;
      const x = anchorVisible ? (Math.max(bounds.left - base.left, 0) + Math.min(bounds.right - base.right, 0)) / z : 0;
      const y = anchorVisible ? (Math.max(bounds.top - base.top, 0) + Math.min(bounds.bottom - base.bottom, 0)) / z : 0;
      if (x !== nx || y !== ny) setNudge({ x, y });
    };
    updateRef.current = update;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(plan);
    observer.observe(pin);
    return () => observer.disconnect();
  }, [pinRef]);
  // Transforms and anchor moves don't trigger ResizeObserver: re-check whenever either changes.
  useLayoutEffect(() => {
    updateRef.current?.();
  }, [view.scale, view.x, view.y, anchor.x, anchor.y]);
  return nudge;
}

export type SectionPinTone = 'default' | 'warn' | 'active';

interface SectionPinProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  ref?: Ref<HTMLDivElement>;
  /** Section label; the badge shows its short form ("Section 3" → "Sec 3"). */
  label: string;
  /** Pin position as fractions (0-1) of the plan. */
  x: number;
  y: number;
  /** Second and third rows (e.g. assignee + "2/15" on the board, pax on setup). */
  secondary: string;
  tertiary: string;
  tone?: SectionPinTone;
  note?: string | null;
}

/**
 * The one section pin used by both the Daily Assignment board and the
 * Sections setup editor: MapPin + "Sec N" badge, then two info rows,
 * anchored (centred) on the section's point on the plan. The element itself
 * is the tap/drop target — callers pass role, handlers and refs through.
 *
 * Keeps its on-screen size at any zoom (counter-scales by 1/zoom), so
 * zooming in spreads crowded pins apart instead of enlarging the overlap,
 * and stays inside the plan's visible box (`useKeepInsidePlan`).
 */
export function SectionPin({ ref, label, x, y, secondary, tertiary, tone = 'default', note, className, style, ...rest }: SectionPinProps) {
  const pinRef = useRef<HTMLDivElement | null>(null);
  const view = usePlanView();
  const nudge = useKeepInsidePlan(pinRef, view, { x, y });
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      pinRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) (ref as { current: HTMLDivElement | null }).current = el;
    },
    [ref],
  );

  return (
    <div
      {...rest}
      ref={setRefs}
      data-section-pin={label}
      className={cn('absolute z-[1] flex -translate-x-1/2 -translate-y-1/2 cursor-pointer flex-col items-center gap-0.5', className)}
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: `translate(${nudge.x}px, ${nudge.y}px)${view.scale !== 1 ? ` scale(${1 / view.scale})` : ''}`,
        ...style,
      }}
    >
      <span
        className={cn(
          'flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 shadow-sm backdrop-blur transition-colors',
          tone === 'warn'
            ? 'border-warning bg-warning/15 text-warning'
            : tone === 'active'
              ? 'border-accent bg-accent/20 text-accent'
              : 'border-border-strong bg-background/90 text-foreground',
        )}
      >
        <MapPin className="h-2.5 w-2.5 shrink-0" />
        <span className="text-[8px] font-semibold leading-none">{sectionPinName(label)}</span>
        {note && (
          <span title={truncateNote(note)} aria-hidden className="flex shrink-0 items-center opacity-70">
            <StickyNote className="h-2.5 w-2.5" />
          </span>
        )}
      </span>
      <span className="whitespace-nowrap rounded-full bg-background/85 px-1.5 py-0.5 text-[8px] font-medium leading-none text-foreground shadow-sm">
        {secondary}
      </span>
      <span
        className={cn(
          'whitespace-nowrap rounded-full px-1.5 py-0.5 text-[8px] font-semibold leading-none',
          tone === 'warn' ? 'bg-warning/20 text-warning' : 'bg-muted text-muted-foreground',
        )}
      >
        {tertiary}
      </span>
    </div>
  );
}
