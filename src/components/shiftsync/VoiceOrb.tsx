/*! @license thinking-orbs 0.3.2 (dot geometry) — MIT © 2026 Jakub Antalik — full notice: docs/THIRD_PARTY.md */
import { useEffect, useRef, type RefObject } from 'react';
import { MODE_FRAMES, resolvePreset, type ModeOpts, type OrbFrame, type OrbState } from 'thinking-orbs/engine';
import { scaleCounts, scaleRadii } from 'thinking-orbs';
import { micLevel, smoothLevel, type OrbLook, type OrbPersonality } from '@/lib/voiceOrb';

/**
 * The voice sheet's dotted orb: thinking-orbs' geometry (MIT, © Jakub Antalik — see
 * docs/THIRD_PARTY.md), drawn here in the app's gold with our own loop, because the stock
 * component has three fixed sizes, no frame-rate cap and nothing that follows the microphone.
 *
 * - Decorative: hidden from screen readers (the sheet says every step in words).
 * - 30 fps except while listening; nothing at all while the page is hidden; a still frame when
 *   the look says so or the person prefers reduced motion.
 * - Fewer dots when frames run slow (measured), never more than the personality asks for.
 * - While listening, the speed and a fine ring follow `level` (the recording's existing level
 *   meter, lib/audioLevel.ts) — no microphone or audio context of its own.
 */

type Rgb = { r: number; g: number; b: number };

/** The `--accent` token as RGB (falls back to the same gold if the token can't be read). */
function accentRgb(): Rgb {
  const raw = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)?.[1];
  const n = hex ? parseInt(hex, 16) : 0xe5a93c;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Brightness steps for the dots' depth shading; colours are built once, not per dot per frame. */
const STEPS = 48;

function inkRamp(gold: Rgb): string[] {
  // The library's dark-substrate ramp: near dots (low `white`) full gold, far ones fade toward black.
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const w = i / STEPS;
    return `rgb(${Math.round(gold.r * (1 - w))},${Math.round(gold.g * (1 - w))},${Math.round(gold.b * (1 - w))})`;
  });
}

function haloSprite(gold: Rgb): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  if (!g) return null;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, `rgba(${gold.r},${gold.g},${gold.b},0.9)`);
  grad.addColorStop(0.45, `rgba(${gold.r},${gold.g},${gold.b},0.25)`);
  grad.addColorStop(1, `rgba(${gold.r},${gold.g},${gold.b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return c;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function paint(ctx: CanvasRenderingContext2D, frame: OrbFrame, ramp: string[], alpha: number, glow: number, halo: HTMLCanvasElement | null) {
  for (const l of frame.lines) {
    ctx.globalAlpha = alpha * (l.a ?? 1);
    ctx.strokeStyle = ramp[Math.round(clamp01(l.white) * STEPS)]!;
    ctx.lineWidth = l.w;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  if (glow > 0 && halo) {
    for (const d of frame.dots) {
      const near = 1 - clamp01(d.white);
      if (near < 0.5) continue;
      const r = d.r * 3.4;
      ctx.globalAlpha = glow * near * alpha * (d.a ?? 1);
      ctx.drawImage(halo, d.x - r, d.y - r, r * 2, r * 2);
    }
  }
  for (const d of frame.dots) {
    ctx.globalAlpha = alpha * (d.a ?? 1);
    ctx.fillStyle = ramp[Math.round(clamp01(d.white) * STEPS)]!;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

interface Shape {
  frame: (size: number, t: number, opts: ModeOpts) => OrbFrame;
  opts: ModeOpts;
  /** The library's preset speed for this state. */
  speed: number;
}

function shapeFor(state: OrbState, density: number, dotSize: number): Shape {
  const preset = resolvePreset(state, 64);
  let opts = scaleCounts(preset.opts, Math.max(0.1, density));
  if (dotSize !== 1) opts = scaleRadii(opts, dotSize);
  return { frame: MODE_FRAMES[preset.mode], opts, speed: preset.speed };
}

/** Frame cost above this (ms, measured average) sheds dots; well below it lets them come back. */
const SLOW_MS = 6;
const FAST_MS = 2.5;
const CROSSFADE_MS = 650;
/** Where a still frame is taken from: a representative, unhurried moment. */
const STILL_T = 0.6;

export interface OrbStats {
  state: OrbState;
  fps: number;
  /** Average and 95th-percentile time to compute and draw one frame, ms. */
  avgMs: number;
  p95Ms: number;
  dots: number;
  /** 1 = the personality's full density; lower = shed for speed. */
  densityScale: number;
}

export function VoiceOrb({
  look,
  size,
  personality,
  level,
  reducedMotion,
  className,
  onStats,
}: {
  look: OrbLook;
  /** CSS pixels, square. */
  size: number;
  personality: OrbPersonality;
  /** The live microphone RMS while recording (null/absent otherwise). */
  level?: RefObject<number | null>;
  reducedMotion: boolean;
  className?: string;
  /** Development measurements (the dev preview route), about twice a second. */
  onStats?: (stats: OrbStats) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The loop reads the latest look and callbacks without restarting.
  const lookRef = useRef(look);
  const statsRef = useRef(onStats);
  const redrawRef = useRef<() => void>(() => {});
  useEffect(() => {
    lookRef.current = look;
    statsRef.current = onStats;
    redrawRef.current();
  }, [look, onStats]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const gold = accentRgb();
    const ramp = inkRamp(gold);
    const halo = personality.glow > 0 ? haloSprite(gold) : null;

    let densityScale = 1;
    const shapes = new Map<OrbState, Shape>();
    const shape = (state: OrbState) => {
      let s = shapes.get(state);
      if (!s) {
        s = shapeFor(state, personality.density * densityScale, personality.dotSize);
        shapes.set(state, s);
      }
      return s;
    };

    // Each state keeps its own clock so speed changes (the mic) never make it jump.
    let current = { state: lookRef.current.state, t: STILL_T };
    let previous: { state: OrbState; t: number; alpha: number } | null = null;
    let fadeStart = 0;
    let alpha = lookRef.current.alpha;
    let smoothed = 0;
    let raf = 0;
    let last = 0;
    let lastDrawn = 0;

    // Measurements: frame costs for shedding dots, and (dev) for the stats readout.
    let ema = 0;
    let slowRun = 0;
    let fastRun = 0;
    const costs: number[] = [];
    let drawnSince = 0;
    let statsAt = 0;

    const draw = (now: number) => {
      const started = performance.now();
      const l = lookRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      let dots = 0;
      if (previous) {
        const k = Math.min(1, (now - fadeStart) / CROSSFADE_MS);
        if (k >= 1) previous = null;
        else {
          const f = shape(previous.state).frame(size, previous.t, shape(previous.state).opts);
          paint(ctx, f, ramp, previous.alpha * (1 - k), personality.glow, halo);
          dots += f.dots.length;
        }
        const f = shape(current.state).frame(size, current.t, shape(current.state).opts);
        paint(ctx, f, ramp, alpha * (previous ? k : 1), personality.glow, halo);
        dots += f.dots.length;
      } else {
        const f = shape(current.state).frame(size, current.t, shape(current.state).opts);
        paint(ctx, f, ramp, alpha, personality.glow, halo);
        dots += f.dots.length;
      }
      // The fine ring that follows the voice: restrained, drawn only while listening.
      if (l.audio && smoothed > 0.02) {
        ctx.globalAlpha = (0.1 + 0.3 * smoothed) * alpha;
        ctx.strokeStyle = ramp[0]!;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, (size / 2) * (0.9 + 0.07 * smoothed), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      const cost = performance.now() - started;
      ema = ema ? ema * 0.9 + cost * 0.1 : cost;
      costs.push(cost);
      if (costs.length > 240) costs.shift();
      drawnSince++;
      return dots;
    };

    const shed = (factor: number) => {
      densityScale = Math.min(1, Math.max(0.35, densityScale * factor));
      shapes.clear();
      slowRun = fastRun = 0;
    };

    const report = (now: number, dots: number) => {
      if (!statsRef.current || now - statsAt < 500) return;
      const sorted = [...costs].sort((a, b) => a - b);
      statsRef.current({
        state: current.state,
        fps: statsAt ? Math.round((drawnSince * 1000) / (now - statsAt)) : 0,
        avgMs: Number(ema.toFixed(2)),
        p95Ms: Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2)),
        dots,
        densityScale: Number(densityScale.toFixed(2)),
      });
      statsAt = now;
      drawnSince = 0;
    };

    const follow = (now: number) => {
      const l = lookRef.current;
      if (l.state !== current.state) {
        previous = { state: current.state, t: current.t, alpha };
        fadeStart = now;
        current = { state: l.state, t: STILL_T };
      }
      alpha += (l.alpha - alpha) * 0.12;
      if (Math.abs(l.alpha - alpha) < 0.005) alpha = l.alpha;
    };

    const tick = (now: number) => {
      raf = 0;
      const l = lookRef.current;
      const animating = l.animate && !reducedMotion;
      const dt = last ? Math.min(100, now - last) : 16;
      // 30 fps unless listening (where the voice should feel immediate).
      if (!l.audio && now - lastDrawn < 1000 / 30 - 2) {
        raf = requestAnimationFrame(tick);
        return;
      }
      last = now;
      lastDrawn = now;
      follow(now);
      const target = l.audio ? micLevel(level?.current ?? 0) : 0;
      smoothed = smoothLevel(smoothed, target, dt);
      const s = shape(current.state);
      const step = (dt / 1000) * s.speed * personality.speed * l.speed * (l.audio ? 0.75 + 0.9 * smoothed : 1);
      current.t += step;
      if (previous) previous.t += (dt / 1000) * shape(previous.state).speed * personality.speed;
      const dots = draw(now);
      // Shed dots when frames run slow; let them back slowly when there is room.
      if (ema > SLOW_MS) {
        if (++slowRun > 30) shed(0.8);
      } else slowRun = 0;
      if (ema < FAST_MS && densityScale < 1) {
        if (++fastRun > 240) shed(1.15);
      } else fastRun = 0;
      report(now, dots);
      if (animating || previous || Math.abs(l.alpha - alpha) > 0) raf = requestAnimationFrame(tick);
      else drawStill();
    };

    /** One still frame (no loop): reduced motion, or a look that doesn't animate. */
    const drawStill = () => {
      const l = lookRef.current;
      previous = null;
      current = { state: l.state, t: STILL_T };
      alpha = l.alpha;
      smoothed = 0;
      draw(performance.now());
    };

    const start = () => {
      if (raf || document.visibilityState === 'hidden') return;
      const l = lookRef.current;
      if (!l.animate || reducedMotion) {
        drawStill();
        return;
      }
      last = 0;
      lastDrawn = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    redrawRef.current = () => {
      // A new look: an animated one (re)starts the loop, which crossfades; a still one is drawn now.
      const l = lookRef.current;
      if (!l.animate || reducedMotion) {
        stop();
        drawStill();
      } else start();
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => {
      stop();
      redrawRef.current = () => {};
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [size, personality, reducedMotion, level]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} style={{ width: size, height: size, display: 'block' }} />;
}
