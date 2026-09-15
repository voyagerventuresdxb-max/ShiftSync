import { useCallback, useEffect, useRef, useState } from 'react';
import { LiquidGlassSphere } from './LiquidSphere';
import './onboarding.css';

/**
 * Onboarding · 01 · Welcome — ported from the locked design prototype
 * (`ShiftSync Welcome.dc.html`). Phases: hold (touch-and-hold, 5 feature
 * icons spiral-absorb into a center liquid sphere) → settled (sphere fades,
 * three-beat text reveal) → carousel (3-slide swipe intro) → done (handoff
 * to Venue).
 *
 * The prototype's own "formed" phase (a separate pool→orb morph reachable
 * only via its internal dev-jump buttons) is dead code in the live gesture
 * path — hold completing goes straight to a hold→settled crossfade — so it's
 * not ported. The prototype's HOLD-phase center mass is a three.js
 * ShaderGradient WebGL mesh loaded at runtime from a CDN; that dependency
 * doesn't fit this app's locked stack (no three.js), so `LiquidGlassSphere`
 * (the prototype's own portable SVG-filter sphere, otherwise only used in
 * the dead "formed" phase) fills that role instead — same warm liquid-glass
 * material, no WebGL/CDN dependency. The phone-bezel/iOS-status-bar/home-
 * indicator chrome and the prototype's design-review scaffolding (palette
 * swatches, motion-token docs, phase-jump buttons) are presentation-only and
 * are not part of the real product screen, so they're dropped too.
 */

type Phase = 'hold' | 'settled' | 'carousel' | 'done';

const ease3 = (x: number) => 1 - Math.pow(1 - x, 3);
const easeOutQuartic = (x: number) => 1 - Math.pow(1 - x, 4);
const easeInOutQuad = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const ramp = (rp: number, from: number, to: number) => Math.max(0, Math.min(1, (rp - from) / (to - from)));

const HOLD_MS = 1000;
const DECAY_MS = 900;
const HANDOFF_MS = 1100;
const REVEAL_MS = 5600;

const R_ORBIT = 150;

interface IconDef {
  angleDeg: number;
  stagger: number;
  floatName: string;
  floatDur: string;
  floatDelay: string;
  render: () => React.ReactNode;
}

const ICON_DEFS: IconDef[] = [
  {
    angleDeg: -60,
    stagger: 0,
    floatName: 'ob-float-a',
    floatDur: '6.2s',
    floatDelay: '0s',
    render: () => (
      <svg width={35} height={35} viewBox="0 0 26 26" fill="none" stroke="#C9A66B" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
        <rect x={4} y={6} width={18} height={16} rx={2} />
        <path d="M4 11 H22 M9 6 V4 M17 6 V4 M9 15 H10 M13 15 H14 M17 15 H18 M9 18 H10 M13 18 H14" />
      </svg>
    ),
  },
  {
    angleDeg: -12,
    stagger: 0.1,
    floatName: 'ob-float-b',
    floatDur: '7.4s',
    floatDelay: '-1.2s',
    render: () => (
      <svg width={35} height={35} viewBox="0 0 26 26" fill="none" stroke="#C9A66B" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
        <rect x={3} y={4} width={20} height={18} rx={1.5} />
        <circle cx={9} cy={10} r={1.8} />
        <circle cx={17} cy={10} r={1.8} />
        <circle cx={9} cy={17} r={1.8} />
        <circle cx={17} cy={17} r={1.8} />
      </svg>
    ),
  },
  {
    angleDeg: 36,
    stagger: 0.2,
    floatName: 'ob-float-c',
    floatDur: '6.8s',
    floatDelay: '-2.6s',
    render: () => (
      <svg width={35} height={35} viewBox="0 0 26 26" fill="none" stroke="#C9A66B" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
        <circle cx={10} cy={10} r={3.2} />
        <path d="M4 21 c 0 -3.4 2.7 -5.6 6 -5.6 s 6 2.2 6 5.6" />
        <circle cx={18} cy={9} r={2.4} />
        <path d="M16.4 15 c 3.2 0 5.6 2 5.6 5" />
      </svg>
    ),
  },
  {
    angleDeg: 132,
    stagger: 0.3,
    floatName: 'ob-float-d',
    floatDur: '7.9s',
    floatDelay: '-3.4s',
    render: () => (
      <svg width={35} height={35} viewBox="0 0 26 26" fill="none" stroke="#C9A66B" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 9 H19 L15 5" />
        <path d="M21 17 H7 L11 21" />
      </svg>
    ),
  },
  {
    angleDeg: -132,
    stagger: 0.4,
    floatName: 'ob-float-e',
    floatDur: '6.5s',
    floatDelay: '-4.1s',
    render: () => (
      <svg width={35} height={35} viewBox="0 0 26 26" fill="none" stroke="#C9A66B" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
        <rect x={10} y={3} width={6} height={12} rx={3} />
        <path d="M6 13 c 0 4 3 7 7 7 s 7 -3 7 -7" />
        <path d="M13 20 V23" />
      </svg>
    ),
  },
];

interface CarouselCard {
  eyebrow: string;
  title: string;
  body: string;
}

const CAROUSEL_CARDS: CarouselCard[] = [
  {
    eyebrow: 'AI Voice.',
    title: 'No more midnight group chats.',
    body: "Say a shift change out loud — Move Yusuf to Section 3 — and it's done. No typing, no confusion.",
  },
  {
    eyebrow: 'Floor Plan.',
    title: 'See your whole floor, staffed.',
    body: 'Drag staff directly onto your real floor layout. Know who covers what, at a glance.',
  },
  {
    eyebrow: 'Smart Import.',
    title: 'Your old roster, made new.',
    body: 'Drop in your existing Excel, CSV, or PDF roster. Review, confirm, done — in minutes, not hours.',
  },
];

const Chevron = ({ opacity = 0.85 }: { opacity?: number }) => (
  <svg width={18} height={10} viewBox="0 0 18 10" fill="none">
    <path d="M2 8l7-6 7 6" stroke="#C9A66B" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" opacity={opacity} />
  </svg>
);

function SlideVisual({ idx }: { idx: number }) {
  if (idx === 0) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 14,
          background: 'linear-gradient(180deg,#0F0D0A,#0A0908)',
          border: '1px solid rgba(239,234,224,.06)',
          overflow: 'hidden',
          padding: '22px 24px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ font: "500 8.5px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Voice</div>
          <div className="ob-serif" style={{ fontSize: 22, lineHeight: 1.25, color: 'var(--ob-bone)', marginTop: 12 }}>
            &quot;Move Yusuf to Section&nbsp;3.&quot;
          </div>
          <div style={{ font: "400 10.5px/1 'Manrope'", color: 'var(--ob-dim-2)', marginTop: 10 }}>Heard · Yusuf O. → Section 3 · Tonight</div>
        </div>
        <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 44 }}>
          {[30, 60, 45, 80, 55, 35, 70, 40, 25, 20, 15].map((h, i) => (
            <div key={i} style={{ flex: 1, background: i < 6 ? '#C9A66B' : i < 9 ? 'var(--ob-bronze)' : 'var(--ob-dim-2)', borderRadius: 1, height: `${h}%` }} />
          ))}
        </div>
      </div>
    );
  }
  if (idx === 1) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 14,
          background: 'linear-gradient(180deg,#0F0D0A,#0A0908)',
          border: '1px solid rgba(239,234,224,.06)',
          overflow: 'hidden',
          padding: '18px 20px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ font: "500 8.5px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Floor · Tonight</div>
          <div style={{ font: "400 9.5px/1 'Manrope'", color: 'var(--ob-dim-2)' }}>8 on · 3 sections</div>
        </div>
        <svg viewBox="0 0 120 62" style={{ width: '100%', flex: 1, marginTop: 10 }} fill="none">
          <rect x={4} y={4} width={52} height={24} rx={2} stroke="#EFEAE0" strokeOpacity={0.2} strokeWidth={0.8} />
          <rect x={62} y={4} width={30} height={24} rx={2} stroke="#EFEAE0" strokeOpacity={0.2} strokeWidth={0.8} />
          <rect x={98} y={4} width={18} height={54} rx={2} stroke="#EFEAE0" strokeOpacity={0.2} strokeWidth={0.8} />
          <rect x={4} y={34} width={88} height={24} rx={2} stroke="#EFEAE0" strokeOpacity={0.2} strokeWidth={0.8} />
          <circle cx={18} cy={16} r={2.4} fill="#C9A66B" />
          <circle cx={32} cy={20} r={2.4} fill="#C9A66B" />
          <circle cx={46} cy={14} r={2.4} fill="#8B7550" />
          <circle cx={76} cy={18} r={2.4} fill="#C9A66B" />
          <circle cx={24} cy={46} r={2.4} fill="#8B7550" />
          <circle cx={52} cy={44} r={2.4} fill="#C9A66B" />
          <circle cx={76} cy={48} r={2.4} fill="#8B7550" />
          <circle cx={107} cy={30} r={2.4} fill="#C9A66B" />
        </svg>
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', inset: 0, borderRadius: 14, background: 'linear-gradient(180deg,#0F0D0A,#0A0908)', border: '1px solid rgba(239,234,224,.06)', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 16, top: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px 7px 10px', borderRadius: 9999, border: '1px solid rgba(239,234,224,.1)', background: 'rgba(30,25,19,.6)', font: "500 11px/1 'Manrope'", color: 'var(--ob-bone)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#C9A66B' }} />
          rota_dec.xlsx
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px 7px 10px', borderRadius: 9999, border: '1px solid rgba(239,234,224,.08)', background: 'rgba(30,25,19,.4)', font: "500 11px/1 'Manrope'", color: 'var(--ob-stone)', marginLeft: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ob-bronze)' }} />
          staff_shifts.csv
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px 7px 10px', borderRadius: 9999, border: '1px solid rgba(239,234,224,.06)', background: 'rgba(30,25,19,.3)', font: "500 11px/1 'Manrope'", color: 'var(--ob-dim-2)', marginLeft: 16 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ob-dim-2)' }} />
          weekly.pdf
        </div>
      </div>
      <svg style={{ position: 'absolute', left: 128, top: 46, opacity: 0.55 }} width={34} height={52} viewBox="0 0 60 52" preserveAspectRatio="none" fill="none">
        <path d="M2 6 C 26 6 36 26 58 26" stroke="#C9A66B" strokeWidth={0.9} strokeLinecap="round" strokeDasharray="2 3" />
        <path d="M2 26 C 26 26 34 26 58 26" stroke="#C9A66B" strokeWidth={0.9} strokeLinecap="round" strokeDasharray="2 3" />
        <path d="M2 46 C 26 46 36 26 58 26" stroke="#C9A66B" strokeWidth={0.9} strokeLinecap="round" strokeDasharray="2 3" />
        <path d="M52 22l6 4-6 4" stroke="#C9A66B" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      <div style={{ position: 'absolute', right: 14, top: 22, bottom: 22, width: 104, borderRadius: 12, background: '#100D0A', border: '1px solid rgba(201,166,107,.18)', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ font: "500 8.5px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Parsed</div>
        <div style={{ height: 1, background: 'rgba(201,166,107,.14)' }} />
        {[
          ['Layla H.', 'Head Server · FoH'],
          ['Yusuf O.', 'Floor · FoH'],
          ['Marta S.', 'Sommelier · Bar'],
        ].map(([name, role]) => (
          <div key={name} style={{ font: "500 11px/1.15 'Manrope'", color: 'var(--ob-bone)' }}>
            {name}
            <span style={{ color: 'var(--ob-dim-2)', fontWeight: 400, display: 'block', fontSize: 9.5, marginTop: 2 }}>{role}</span>
          </div>
        ))}
        <div style={{ font: "400 9.5px/1 'Manrope'", color: 'var(--ob-dim-2)', marginTop: 'auto' }}>+ 5 more</div>
      </div>
    </div>
  );
}

export default function WelcomeScreen({ onContinue }: { onContinue: () => void }) {
  const [phase, setPhase] = useState<Phase>('hold');
  const phaseRef = useRef<Phase>('hold');
  const setPhaseSafe = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const [holdActive, setHoldActive] = useState(false);
  const holdActiveRef = useRef(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const [handoffProg, setHandoffProg] = useState(0);
  const [revealProg, setRevealProg] = useState(0);

  const [cardIdx, setCardIdx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragX, setDragX] = useState(0);

  const holdRaf = useRef<number | null>(null);
  const decayRaf = useRef<number | null>(null);
  const handoffRaf = useRef<number | null>(null);
  const revealRaf = useRef<number | null>(null);
  const holdStartedAt = useRef(0);
  const settledSwipeStartY = useRef<number | null>(null);

  const cancelAll = () => {
    if (holdRaf.current) cancelAnimationFrame(holdRaf.current);
    if (decayRaf.current) cancelAnimationFrame(decayRaf.current);
    if (handoffRaf.current) cancelAnimationFrame(handoffRaf.current);
    if (revealRaf.current) cancelAnimationFrame(revealRaf.current);
  };
  useEffect(() => cancelAll, []);

  const startReveal = useCallback(() => {
    if (revealRaf.current) cancelAnimationFrame(revealRaf.current);
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / REVEAL_MS);
      setRevealProg(t);
      if (t < 1) revealRaf.current = requestAnimationFrame(tick);
    };
    revealRaf.current = requestAnimationFrame(tick);
  }, []);

  const startHandoff = useCallback(() => {
    if (handoffRaf.current) cancelAnimationFrame(handoffRaf.current);
    const start = performance.now();
    startReveal();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / HANDOFF_MS);
      setHandoffProg(easeInOutQuad(t));
      if (t < 1) {
        handoffRaf.current = requestAnimationFrame(step);
      } else {
        setPhaseSafe('settled');
        setHandoffProg(1);
      }
    };
    handoffRaf.current = requestAnimationFrame(step);
  }, [setPhaseSafe, startReveal]);

  const startHold = useCallback(() => {
    if (phaseRef.current !== 'hold') return;
    if (decayRaf.current) cancelAnimationFrame(decayRaf.current);
    holdActiveRef.current = true;
    setHoldActive(true);
    holdStartedAt.current = performance.now();
    const tick = () => {
      if (!holdActiveRef.current) return;
      const t = performance.now() - holdStartedAt.current;
      const p = Math.min(1, t / HOLD_MS);
      setHoldProgress(p);
      if (p >= 1) {
        holdActiveRef.current = false;
        setHoldActive(false);
        setHoldProgress(1);
        setRevealProg(0);
        setHandoffProg(0);
        startHandoff();
        return;
      }
      holdRaf.current = requestAnimationFrame(tick);
    };
    holdRaf.current = requestAnimationFrame(tick);
  }, [startHandoff]);

  const endHold = useCallback(() => {
    if (phaseRef.current !== 'hold') return;
    if (!holdActiveRef.current) return;
    holdActiveRef.current = false;
    setHoldActive(false);
    if (holdRaf.current) cancelAnimationFrame(holdRaf.current);
    const start = performance.now();
    setHoldProgress((from) => {
      const decay = () => {
        const t = performance.now() - start;
        const p = Math.max(0, from - t / DECAY_MS);
        setHoldProgress(p);
        if (p > 0 && !holdActiveRef.current && phaseRef.current === 'hold') {
          decayRaf.current = requestAnimationFrame(decay);
        }
      };
      decayRaf.current = requestAnimationFrame(decay);
      return from;
    });
  }, []);

  const resetToHold = useCallback(() => {
    cancelAll();
    holdActiveRef.current = false;
    settledSwipeStartY.current = null;
    setHoldActive(false);
    setHoldProgress(0);
    setHandoffProg(0);
    setRevealProg(0);
    setCardIdx(0);
    setDragX(0);
    setPhaseSafe('hold');
  }, [setPhaseSafe]);

  // ── Root pointer gesture: hold (hold-phase) / swipe-up (settled-phase) ──
  const onRootPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (phaseRef.current === 'hold') {
        startHold();
      } else if (phaseRef.current === 'settled') {
        settledSwipeStartY.current = e.clientY;
      }
    },
    [startHold],
  );
  const onRootPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (phaseRef.current === 'hold') {
        endHold();
      } else if (phaseRef.current === 'settled' && settledSwipeStartY.current != null) {
        const dy = settledSwipeStartY.current - e.clientY;
        settledSwipeStartY.current = null;
        if (dy > 80) setPhaseSafe('carousel');
      }
    },
    [endHold, setPhaseSafe],
  );

  const advanceToCarousel = useCallback(() => {
    if (revealProg >= 0.98) setPhaseSafe('carousel');
  }, [revealProg, setPhaseSafe]);

  // ── Carousel card drag (window-level tracking, like the prototype) ──
  const dragStartX = useRef(0);
  const unbindDragRef = useRef<(() => void) | null>(null);
  const onCardDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    dragStartX.current = e.clientX;
    setDragging(true);
    setDragX(0);
    const onMove = (ev: PointerEvent) => setDragX(ev.clientX - dragStartX.current);
    const onUp = (ev: PointerEvent) => {
      unbindDragRef.current?.();
      const finalDx = ev.clientX - dragStartX.current;
      setDragging(false);
      setDragX(0);
      const THRESH = 60;
      if (finalDx < -THRESH) onPrimaryRef.current();
      else if (finalDx > THRESH) setCardIdx((i) => Math.max(0, i - 1));
    };
    unbindDragRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);
  useEffect(() => () => unbindDragRef.current?.(), []);

  const onPrimary = useCallback(() => {
    setCardIdx((i) => {
      if (i < 2) return i + 1;
      setPhaseSafe('done');
      return i;
    });
  }, [setPhaseSafe]);
  const onPrimaryRef = useRef(onPrimary);
  onPrimaryRef.current = onPrimary;

  // ── Derived render values (hold phase) ──
  const p = holdProgress;
  const sphereWaviness = 1 - p * 0.45;
  const sphereBodyOpacity = 0.42 + p * 0.33;

  const iconStyles = ICON_DEFS.map(({ angleDeg, stagger }) => {
    const local = Math.max(0, Math.min(1, (p - stagger) / (1 - stagger)));
    const t = ease3(local);
    const arc = t * 35 * (angleDeg < 0 ? -1 : 1);
    const theta = ((angleDeg + arc) * Math.PI) / 180;
    const r = R_ORBIT * (1 - t);
    const x = Math.cos(theta) * r;
    const y = Math.sin(theta) * r;
    const scale = 1 - t * 0.55;
    const opacity = local < 0.85 ? 1 - local * 0.2 : Math.max(0, 1 - (local - 0.85) / 0.15);
    const blur = local > 0.78 ? (local - 0.78) * 10 : 0;
    return { x, y, scale, opacity, blur, local };
  });
  let arrivalStrength = 0;
  for (const { local } of iconStyles) {
    if (local > 0.78 && local < 0.98) arrivalStrength = Math.max(arrivalStrength, 1 - Math.abs(local - 0.88) / 0.1);
  }
  const pulseSize = 220 + arrivalStrength * 120;

  // ── Derived render values (settled reveal timeline, rp 0→1 over 5.6s) ──
  const rp = revealProg;
  const openIn = easeOutQuartic(ramp(rp, 0.14, 0.26));
  const openOut = easeInOutQuad(ramp(rp, 0.44, 0.54));
  const openerOp = openIn * (1 - openOut);
  const openerTy = (1 - openIn) * 14 - openOut * 10;
  const stackIn = easeInOutQuad(ramp(rp, 0.44, 0.56));
  const lineStyle = (i: number) => {
    const start = 0.54 + i * 0.12;
    const eased = easeOutQuartic(ramp(rp, start, start + 0.12));
    return { opacity: eased, transform: `translateY(${((1 - eased) * 14).toFixed(2)}px)`, filter: `blur(${((1 - eased) * 4).toFixed(2)}px)` };
  };
  const subEased = easeOutQuartic(ramp(rp, 0.9, 1.0));
  const settledHintOpacity = rp > 0.98 ? 1 : 0;

  const isSettled = phase === 'settled' || (phase === 'hold' && handoffProg > 0);

  return (
    <div
      className="ob-root"
      style={{ position: 'fixed', inset: 0, zIndex: 50, overflow: 'hidden', touchAction: 'none', userSelect: 'none' }}
      onPointerDown={onRootPointerDown}
      onPointerUp={onRootPointerUp}
      onPointerCancel={onRootPointerUp}
    >
      <div
        style={{
          position: 'absolute',
          inset: '-8%',
          background:
            'radial-gradient(60% 50% at 30% 22%,rgba(201,166,107,.08),transparent 55%),radial-gradient(80% 60% at 78% 78%,rgba(60,40,20,.35),transparent 60%),radial-gradient(120% 90% at 50% 50%,#100D0A 0%,#070605 60%,#050403 100%)',
          animation: 'ob-ambient 14s cubic-bezier(.32,.72,0,1) infinite',
          zIndex: 1,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: -40,
          top: -40,
          width: '70%',
          height: '60%',
          background: 'radial-gradient(closest-side,rgba(201,166,107,.22),transparent 70%)',
          filter: 'blur(28px)',
          opacity: 0.8,
          pointerEvents: 'none',
          zIndex: 2,
          animation: 'ob-rim 9s ease-in-out infinite',
        }}
      />

      <div style={{ position: 'relative', width: '100%', maxWidth: 460, height: '100%', margin: '0 auto' }}>
        {(phase === 'hold' || isSettled) && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 66,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              zIndex: 12,
              opacity: 1,
              transition: 'opacity .5s cubic-bezier(.32,.72,0,1)',
            }}
          >
            <img src="/shiftsync-mark.svg" alt="ShiftSync" width={88} height={44} style={{ display: 'block', marginBottom: 10 }} />
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
              <span className="ob-serif" style={{ fontSize: 15, letterSpacing: '.02em', color: 'var(--ob-bone)' }}>
                ShiftSync
              </span>
              <span style={{ display: 'inline-block', width: 1, height: 11, background: 'var(--ob-bronze)', opacity: 0.6 }} />
              <span style={{ font: "500 10px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Manager</span>
            </div>
          </div>
        )}

        {phase === 'hold' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              opacity: 1 - handoffProg,
              transform: `scale(${(1 - handoffProg * 0.08).toFixed(3)})`,
              transformOrigin: '50% 50%',
              pointerEvents: handoffProg > 0.02 ? 'none' : 'auto',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%,-50%)',
                width: 340,
                height: 340,
                borderRadius: '50%',
                background: `radial-gradient(circle,rgba(239,218,168,${(0.42 + p * 0.2).toFixed(3)}) 0%,rgba(201,166,107,${(0.24 + p * 0.1).toFixed(3)}) 28%,rgba(201,166,107,0.08) 58%,rgba(201,166,107,0) 82%)`,
                filter: `blur(${(22 - p * 6).toFixed(1)}px)`,
                mixBlendMode: 'screen',
                opacity: (0.85 + p * 0.15).toFixed(3),
                pointerEvents: 'none',
                zIndex: 2,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%,-50%)',
                width: 200,
                height: 200,
                pointerEvents: 'none',
                zIndex: 3,
                opacity: (0.72 + p * 0.2).toFixed(3),
                borderRadius: '50%',
                overflow: 'hidden',
                mixBlendMode: 'screen',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <LiquidGlassSphere size={200} waviness={sphereWaviness} opacity={sphereBodyOpacity} active={holdActive} />
            </div>
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: pulseSize,
                height: pulseSize,
                transform: 'translate(-50%,-50%)',
                borderRadius: '50%',
                background: `radial-gradient(circle,rgba(239,218,168,${(0.3 * arrivalStrength).toFixed(3)}) 0%,rgba(201,166,107,${(0.14 * arrivalStrength).toFixed(3)}) 40%,rgba(201,166,107,0) 72%)`,
                filter: `blur(${(6 + arrivalStrength * 8).toFixed(1)}px)`,
                mixBlendMode: 'screen',
                opacity: arrivalStrength,
                pointerEvents: 'none',
                zIndex: 3,
              }}
            />

            {ICON_DEFS.map((def, i) => {
              const s = iconStyles[i]!;
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: 35,
                    height: 35,
                    margin: '-17.5px 0 0 -17.5px',
                    transform: `translate(${s.x.toFixed(2)}px,${s.y.toFixed(2)}px) scale(${s.scale.toFixed(3)})`,
                    opacity: s.opacity,
                    filter: `blur(${s.blur.toFixed(2)}px)`,
                    zIndex: 4,
                    pointerEvents: 'none',
                  }}
                >
                  <div style={{ position: 'absolute', inset: -14, borderRadius: '50%', background: 'radial-gradient(circle,rgba(239,218,168,.32) 0%,rgba(201,166,107,.14) 45%,rgba(201,166,107,0) 75%)', filter: 'blur(6px)', mixBlendMode: 'screen', pointerEvents: 'none' }} />
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      animation: `${def.floatName} ${def.floatDur} ease-in-out infinite`,
                      animationDelay: def.floatDelay,
                      filter: 'drop-shadow(0 0 3px rgba(201,166,107,.55)) drop-shadow(0 0 8px rgba(239,218,168,.35))',
                    }}
                  >
                    {def.render()}
                  </div>
                </div>
              );
            })}

            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 16, textAlign: 'center', font: "500 10px/1 'Manrope'", letterSpacing: '.32em', textTransform: 'uppercase', color: 'var(--ob-dim-2)', zIndex: 20 }}>
              Welcome
            </div>
          </div>
        )}

        {isSettled && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 12, opacity: 1, pointerEvents: phase === 'settled' ? 'auto' : 'none' }}>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: '50%',
                transform: `translateY(calc(-50% + ${openerTy.toFixed(2)}px))`,
                padding: '0 36px',
                textAlign: 'center',
                opacity: openerOp,
                pointerEvents: 'none',
              }}
            >
              <div className="ob-serif" style={{ fontSize: 44, lineHeight: 1.1, color: 'var(--ob-champagne)', letterSpacing: '-.01em' }}>
                Ready to reclaim your&nbsp;time.
              </div>
            </div>

            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                padding: '0 40px',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                opacity: stackIn,
              }}
            >
              <div className="ob-serif" style={{ fontSize: 34, lineHeight: 1.15, color: 'var(--ob-champagne)', letterSpacing: '-.005em', ...lineStyle(0) }}>
                One system.
              </div>
              <div className="ob-serif" style={{ fontSize: 34, lineHeight: 1.15, color: 'var(--ob-champagne)', letterSpacing: '-.005em', ...lineStyle(1) }}>
                Every shift.
              </div>
              <div className="ob-serif" style={{ fontSize: 34, lineHeight: 1.15, color: 'var(--ob-champagne)', letterSpacing: '-.005em', ...lineStyle(2) }}>
                Every section.
              </div>
              <div style={{ font: "500 13.5px/1.5 'Manrope'", color: 'var(--ob-bronze)', letterSpacing: '-.005em', marginTop: 22, opacity: subEased, transform: `translateY(${((1 - subEased) * 8).toFixed(2)}px)` }}>
                AI-powered convenience for your daily operations.
              </div>
            </div>

            <button
              onClick={advanceToCarousel}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 36,
                textAlign: 'center',
                opacity: settledHintOpacity,
                transition: 'opacity 500ms cubic-bezier(.16,1,.3,1)',
                background: 'transparent',
                border: 0,
                cursor: settledHintOpacity ? 'pointer' : 'default',
              }}
            >
              <div style={{ position: 'relative', height: 34 }}>
                <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)', animation: 'ob-chevron 2.4s cubic-bezier(.32,.72,0,1) infinite' }}>
                  <Chevron opacity={0.7} />
                </div>
              </div>
              <div style={{ font: "500 10.5px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-bronze)', marginTop: 2 }}>Swipe up · Continue</div>
            </button>
          </div>
        )}

        {phase === 'carousel' && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 10, animation: 'ob-fade-in .6s cubic-bezier(.32,.72,0,1) both' }}>
            <div
              style={{
                position: 'absolute',
                inset: '-6%',
                background:
                  'radial-gradient(45% 40% at 24% 18%,rgba(201,166,107,.12),transparent 60%),radial-gradient(60% 55% at 78% 78%,rgba(60,40,20,.42),transparent 65%),linear-gradient(180deg,#0A0908,#050403)',
                transform: `translate3d(${(-dragX * 0.4).toFixed(1)}px,0,0)`,
                transition: dragging ? 'none' : 'transform .52s cubic-bezier(.32,.72,0,1)',
                zIndex: 1,
              }}
            />

            <div style={{ position: 'absolute', left: 24, right: 24, top: 82, bottom: 112, perspective: 1200, zIndex: 2 }}>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 22,
                  background: 'linear-gradient(180deg,#100D0A,#0A0908)',
                  border: '1px solid rgba(239,234,224,.05)',
                  boxShadow: '0 12px 30px -14px rgba(0,0,0,.6)',
                  transform: `translate3d(0,${(18 - Math.min(1, Math.abs(dragX) / 180) * 18).toFixed(1)}px,0) scale(${(0.94 + Math.min(1, Math.abs(dragX) / 180) * 0.06).toFixed(3)})`,
                  transformOrigin: 'center top',
                  opacity: (0.65 + Math.min(1, Math.abs(dragX) / 180) * 0.35).toFixed(3),
                  transition: dragging ? 'none' : 'transform .52s cubic-bezier(.32,.72,0,1),opacity .52s cubic-bezier(.32,.72,0,1)',
                }}
              >
                <div style={{ padding: '28px 26px 24px' }}>
                  <div style={{ font: "500 10.5px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>
                    {(CAROUSEL_CARDS[Math.min(2, cardIdx + 1)] ?? CAROUSEL_CARDS[cardIdx])!.eyebrow}
                  </div>
                  <div className="ob-serif" style={{ fontSize: 26, lineHeight: 1.12, color: 'var(--ob-bone)', marginTop: 14, letterSpacing: '-.005em' }}>
                    {(CAROUSEL_CARDS[Math.min(2, cardIdx + 1)] ?? CAROUSEL_CARDS[cardIdx])!.title}
                  </div>
                </div>
              </div>

              <div
                onPointerDown={onCardDown}
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 22,
                  boxShadow: '0 30px 60px -20px rgba(0,0,0,.75),0 0 0 1px rgba(239,234,224,.06)',
                  overflow: 'hidden',
                  transform: `translate3d(${dragX}px, ${(Math.abs(dragX) * 0.04).toFixed(1)}px, 0) rotate(${(dragX / 12).toFixed(2)}deg)`,
                  transition: dragging ? 'none' : 'transform .52s cubic-bezier(.32,.72,0,1)',
                  touchAction: 'none',
                  cursor: dragging ? 'grabbing' : 'grab',
                }}
              >
                <div style={{ position: 'absolute', inset: 0, borderRadius: 22, background: 'radial-gradient(120% 70% at 20% 0%,rgba(201,166,107,.09),transparent 55%),linear-gradient(180deg,#14110D 0%,#0C0A08 100%)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', inset: 0, borderRadius: 22, borderTop: '1px solid rgba(201,166,107,.22)', pointerEvents: 'none' }} />

                <div style={{ position: 'relative', height: '100%', padding: '32px 28px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
                      <div style={{ font: "500 10.5px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>{CAROUSEL_CARDS[cardIdx]!.eyebrow}</div>
                      <div style={{ font: "400 10.5px/1 'Manrope'", color: 'var(--ob-dim-2)', letterSpacing: '.02em' }}>{cardIdx + 1} / 3</div>
                    </div>
                    <div className="ob-serif" style={{ fontSize: 30, lineHeight: 1.1, color: 'var(--ob-bone)', letterSpacing: '-.005em' }}>{CAROUSEL_CARDS[cardIdx]!.title}</div>
                    <div style={{ font: "400 14px/1.55 'Manrope'", color: 'var(--ob-stone)', marginTop: 14, maxWidth: 280 }}>{CAROUSEL_CARDS[cardIdx]!.body}</div>
                  </div>

                  <div style={{ height: 200, position: 'relative', margin: '14px -4px 22px' }}>
                    <SlideVisual idx={cardIdx} />
                  </div>

                  <div>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 22 }}>
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          style={{
                            width: i === cardIdx ? 22 : 5,
                            height: 5,
                            borderRadius: 3,
                            background: i === cardIdx ? '#C9A66B' : 'rgba(239,234,224,.18)',
                            transition: 'width .42s cubic-bezier(.32,.72,0,1),background .42s cubic-bezier(.32,.72,0,1)',
                          }}
                        />
                      ))}
                    </div>
                    <button
                      onClick={onPrimary}
                      style={{
                        width: '100%',
                        padding: '16px 20px',
                        borderRadius: 14,
                        background: 'var(--ob-bone)',
                        color: '#100D0A',
                        font: "600 14px/1 'Manrope'",
                        letterSpacing: '.005em',
                        // No inline `transition` here on purpose — this is a
                        // plain <button>, so the app-wide global.css rule
                        // (`button{transition:transform 0.1s ease}` +
                        // `button:active{transform:scale(0.97)}`) already
                        // gives it press feedback. An inline transition would
                        // override that per-element instead of reusing it —
                        // decided against keeping the prototype's own bespoke
                        // .22s/scale(.985) value alive here.
                      }}
                    >
                      {cardIdx < 2 ? 'Continue' : 'Begin — set up your venue'}
                    </button>
                    <div style={{ textAlign: 'center', marginTop: 14 }}>
                      <button
                        onClick={() => setCardIdx(2)}
                        style={{ font: "500 12px/1 'Manrope'", letterSpacing: '.005em', color: 'var(--ob-bronze)', borderBottom: '1px solid rgba(139,117,80,.35)', paddingBottom: 2, background: 'transparent', border: 0 }}
                      >
                        Skip intro
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              animation: 'ob-fade-in .6s cubic-bezier(.32,.72,0,1) both',
              background: 'linear-gradient(180deg,#0A0908,#050403)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: '0 40px',
            }}
          >
            <img src="/shiftsync-mark.svg" alt="ShiftSync" style={{ width: 88, height: 44, display: 'block', marginBottom: 28 }} />
            <div className="ob-serif" style={{ fontSize: 34, lineHeight: 1.15, color: 'var(--ob-champagne)', letterSpacing: '-.005em' }}>Let&apos;s set up your venue.</div>
            <div style={{ font: "500 13.5px/1.55 'Manrope'", color: 'var(--ob-bronze)', marginTop: 14, maxWidth: 260 }}>Next: name your venue, add your floor, and invite your team.</div>
            <button
              onClick={onContinue}
              style={{ marginTop: 36, display: 'inline-block', padding: '15px 28px', borderRadius: 14, background: 'var(--ob-bone)', color: '#100D0A', font: "600 14px/1 'Manrope'", letterSpacing: '.005em' }}
            >
              Continue to Venue
            </button>
            <button
              onClick={resetToHold}
              style={{ marginTop: 18, font: "500 11px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-dim-2)', borderBottom: '1px solid rgba(85,81,74,.5)', paddingBottom: 3, background: 'transparent', border: 0 }}
            >
              Back to start
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
