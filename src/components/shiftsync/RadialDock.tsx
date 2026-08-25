import { useNavigate, useLocation } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Home, Map, Mic, Sparkles, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/scheduling', label: 'Scheduling', icon: CalendarDays },
  { to: '/floor-plan', label: 'Floor plan', icon: Map },
  { to: '/people', label: 'People', icon: Users },
] as const;

/** dial geometry: 5 stations across a ~140° arc, station 0 = focused (under keystone) */
const STATIONS = 5;
const STEP_DEG = 35;
const RX = 34; // horizontal spread, % of dock width
const RY = 14; // vertical sag in px
const DRAG_PX_PER_STATION = 46; // shorter drag distance per tab
const SNAP_DISTANCE = 0.24; // ~24% of station spacing commits a move
const FLICK_VELOCITY = 2.2; // stations / second

/** wrap a station offset into (-2.5, 2.5] so icons travel around the dial */
function wrapStation(v: number) {
  const m = ((v % STATIONS) + STATIONS) % STATIONS;
  return m > STATIONS / 2 ? m - STATIONS : m;
}

/** spring-driven dial value */
function useDial(target: number) {
  const [value, setValue] = useState(target);
  const state = useRef({ value: target, velocity: 0, target, raf: 0 });

  const tick = useCallback(() => {
    const s = state.current;
    const stiffness = 170;
    const damping = 20;
    const dt = 1 / 60;
    const force = (s.target - s.value) * stiffness - s.velocity * damping;
    s.velocity += force * dt;
    s.value += s.velocity * dt;
    if (Math.abs(s.target - s.value) < 0.0008 && Math.abs(s.velocity) < 0.0008) {
      s.value = s.target;
      s.velocity = 0;
      setValue(s.value);
      s.raf = 0;
      return;
    }
    setValue(s.value);
    s.raf = requestAnimationFrame(tick);
  }, []);

  const animateTo = useCallback(
    (next: number, velocity?: number) => {
      const s = state.current;
      s.target = next;
      if (typeof velocity === 'number') s.velocity = velocity;
      if (!s.raf) s.raf = requestAnimationFrame(tick);
    },
    [tick],
  );

  const setImmediate = useCallback((next: number) => {
    const s = state.current;
    if (s.raf) cancelAnimationFrame(s.raf);
    s.raf = 0;
    s.value = next;
    s.target = next;
    s.velocity = 0;
    setValue(next);
  }, []);

  useEffect(
    () => () => {
      if (state.current.raf) cancelAnimationFrame(state.current.raf);
    },
    [],
  );

  return { value, animateTo, setImmediate, current: () => state.current.value };
}

export function RadialDock({
  listening,
  onToggleListening,
}: {
  listening: boolean;
  onToggleListening: () => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => (t.to === '/' ? pathname === '/' : pathname.startsWith(t.to))),
  );

  const dial = useDial(activeIndex);
  const drag = useRef<{
    id: number;
    x: number;
    from: number;
    moved: boolean;
    lastX: number;
    lastT: number;
    velocity: number; // stations / second
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pulseIndex, setPulseIndex] = useState<number | null>(null);

  // keep the dial locked onto the active route (spring easing)
  useEffect(() => {
    const from = dial.current();
    const target = from + wrapStation(activeIndex - from);
    dial.animateTo(target);
    setPulseIndex(activeIndex);
    const t = setTimeout(() => setPulseIndex(null), 420);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const go = (index: number) => {
    if (index === activeIndex) {
      setPulseIndex(index);
      setTimeout(() => setPulseIndex(null), 420);
      const from = dial.current();
      dial.animateTo(from + wrapStation(index - from));
      return;
    }
    navigate(tabs[index]!.to);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      from: dial.current(),
      moved: false,
      lastX: e.clientX,
      lastT: e.timeStamp,
      velocity: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 4) {
      d.moved = true;
      setDragging(true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    }
    if (!d.moved) return;
    dial.setImmediate(d.from - dx / DRAG_PX_PER_STATION);
    const dt = Math.max(8, e.timeStamp - d.lastT) / 1000;
    const v = -(e.clientX - d.lastX) / DRAG_PX_PER_STATION / dt;
    d.velocity = d.velocity * 0.6 + v * 0.4;
    d.lastX = e.clientX;
    d.lastT = e.timeStamp;
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d || !d.moved) return;

    const value = dial.current();
    const start = Math.round(d.from);
    const offset = value - start;
    const flick = Math.abs(d.velocity) > FLICK_VELOCITY;

    let snapped: number;
    if (flick) {
      snapped = d.velocity > 0 ? Math.max(start + 1, Math.ceil(value)) : Math.min(start - 1, Math.floor(value));
    } else if (Math.abs(offset) >= SNAP_DISTANCE) {
      snapped = offset > 0 ? Math.ceil(value) : Math.floor(value);
    } else {
      snapped = start;
    }

    dial.animateTo(snapped, d.velocity);
    const index = ((snapped % tabs.length) + tabs.length) % tabs.length;
    if (index !== activeIndex) navigate(tabs[index]!.to);
    e.preventDefault();
  };

  return (
    <nav
      aria-label="Primary"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="pointer-events-auto relative mx-4 h-[54px] w-full max-w-sm touch-pan-y"
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      >
        <div
          className="glass-bar absolute inset-0"
          style={{
            borderRadius: '50% 50% 1rem 1rem / 30px 30px 1rem 1rem',
            boxShadow: '0 10px 24px -14px oklch(0 0 0 / 0.7)',
          }}
        >
          <span className="gold-rule pointer-events-none absolute inset-x-12 top-[24px] h-px opacity-15" />
        </div>

        {tabs.map((tab, i) => {
          const offset = wrapStation(i - dial.value);
          const angle = (offset * STEP_DEG * Math.PI) / 180;
          const edge = Math.min(1, Math.abs(offset) / 2.2);
          const focus = Math.max(0, 1 - Math.abs(offset));
          const isActive = i === activeIndex;
          const Icon = tab.icon;
          return (
            <button
              key={tab.to}
              type="button"
              onClick={() => !drag.current?.moved && go(i)}
              aria-label={tab.label}
              aria-current={isActive ? 'page' : undefined}
              className="absolute top-0 grid h-10 w-10 place-items-center rounded-full"
              style={{
                left: `calc(50% + ${Math.sin(angle) * RX}% )`,
                transform: `translate(-50%, ${11 + (1 - Math.cos(angle)) * RY}px) scale(${
                  0.86 + focus * 0.16 + (pulseIndex === i ? 0.08 : 0)
                })`,
                opacity: 1 - edge * 0.9,
                transition: pulseIndex === i ? 'transform 260ms cubic-bezier(0.34,1.56,0.64,1)' : undefined,
              }}
            >
              <span
                className={cn(
                  'absolute inset-0 rounded-full transition-all duration-300',
                  isActive ? 'glow-gold bg-accent/18' : 'bg-transparent',
                )}
              />
              <Icon
                className={cn('relative h-[18px] w-[18px] transition-colors duration-300', isActive ? 'text-accent' : 'text-foreground/40')}
                strokeWidth={isActive ? 2.4 : 1.6}
                fill={isActive ? 'currentColor' : 'none'}
                fillOpacity={isActive ? 0.22 : 0}
              />
            </button>
          );
        })}

        {/* fixed keystone: AI / voice — no voice backend, this only flips local `listening` state */}
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onToggleListening}
          aria-pressed={listening}
          aria-label="Toggle AI voice assistant"
          className={cn(
            'glass-bar absolute left-1/2 top-[-26px] grid h-10 w-10 -translate-x-1/2 place-items-center rounded-full transition-all duration-300',
            listening ? 'text-accent-foreground' : 'text-accent hover:brightness-125',
          )}
          style={{
            backgroundImage: listening
              ? 'radial-gradient(120% 120% at 50% 15%, color-mix(in oklab, var(--accent) 92%, transparent), color-mix(in oklab, var(--accent) 62%, transparent))'
              : 'radial-gradient(120% 120% at 50% 15%, color-mix(in oklab, oklch(1 0 0) 16%, transparent), color-mix(in oklab, var(--accent) 12%, transparent))',
            animation: listening ? 'breathe 2.4s ease-in-out infinite' : undefined,
            transitionTimingFunction: 'cubic-bezier(0.34,1.56,0.64,1)',
          }}
        >
          {listening ? <Mic className="h-[18px] w-[18px]" /> : <Sparkles className="h-4 w-4" />}
        </button>
      </div>
    </nav>
  );
}
