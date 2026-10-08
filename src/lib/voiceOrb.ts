import type { OrbState } from 'thinking-orbs/engine';

/**
 * How the voice sheet's orb looks in each step. The orb is decoration only (hidden from screen
 * readers): every step is also said in words. Calm on purpose: slow, gold, and still whenever
 * something went wrong.
 */

/** Where a voice command is up to, as far as the orb is concerned. */
export type OrbPhase =
  /** Nothing running yet: the keyboard is open, or the microphone is starting. */
  | 'ready'
  | 'listening'
  /** The recording is being turned into words. */
  | 'transcribing'
  /** The words are being read and names matched. */
  | 'understanding'
  /** A preview or an answer is on the sheet. */
  | 'confirm'
  /** "Which one?": people or readings to pick from. */
  | 'choose'
  /** Confirm was tapped and the change is being made. */
  | 'sending'
  /** Didn't catch that, not by voice: a still, dim orb above the sheet. */
  | 'unclear'
  /** Offline, microphone off, timeout, limit: a still, dim orb with the message. */
  | 'problem';

export interface OrbLook {
  /** Which of the library's shapes to draw. */
  state: OrbState;
  /** Ink strength: 1 is full gold; lower is dim. */
  alpha: number;
  /** False: one still frame, no animation at all. */
  animate: boolean;
  /** Multiplier on the orb's own calm speed. */
  speed: number;
  /** While listening: the speed and a fine ring follow the microphone level. */
  audio: boolean;
  /** How large the sheet shows it: 1 is full size, smaller is the ring above a preview. */
  scale: number;
}

const SMALL = 0.42;

const LOOKS: Record<OrbPhase, OrbLook> = {
  ready: { state: 'breathing', alpha: 1, animate: true, speed: 1, audio: false, scale: 1 },
  listening: { state: 'listening', alpha: 1, animate: true, speed: 1, audio: true, scale: 1 },
  transcribing: { state: 'working', alpha: 1, animate: true, speed: 1, audio: false, scale: 1 },
  understanding: { state: 'connecting', alpha: 1, animate: true, speed: 1, audio: false, scale: 1 },
  confirm: { state: 'breathing', alpha: 1, animate: true, speed: 0.7, audio: false, scale: SMALL },
  choose: { state: 'breathing', alpha: 0.55, animate: true, speed: 0.6, audio: false, scale: SMALL },
  sending: { state: 'composing', alpha: 1, animate: true, speed: 1, audio: false, scale: SMALL },
  unclear: { state: 'breathing', alpha: 0.38, animate: false, speed: 0, audio: false, scale: SMALL },
  problem: { state: 'breathing', alpha: 0.38, animate: false, speed: 0, audio: false, scale: 1 },
};

/** The orb for a step. With reduced motion every step is one still frame. */
export function orbLook(phase: OrbPhase, reducedMotion: boolean): OrbLook {
  const look = LOOKS[phase];
  return reducedMotion ? { ...look, animate: false, audio: false } : look;
}

/** The two personalities: the recommended one (a) and the alternative (b) in the dev preview. */
export type OrbVariant = 'a' | 'b';

export interface OrbPersonality {
  /** Dot density relative to the library's tuned 64 px preset. */
  density: number;
  /** Dot radius multiplier. */
  dotSize: number;
  /** Multiplier on the library's preset speed (which is tuned for small spinners). */
  speed: number;
  /** Strength of the warm halo around the nearest dots (0: none). */
  glow: number;
}

export const ORB_PERSONALITIES: Record<OrbVariant, OrbPersonality> = {
  // Quiet: fewer, softer dots, slow, a warm halo on the nearest ones.
  a: { density: 1.5, dotSize: 1.1, speed: 0.38, glow: 0.2 },
  // Fine: a denser, crisper constellation, a little livelier, no halo.
  b: { density: 2.6, dotSize: 0.78, speed: 0.55, glow: 0 },
};

/**
 * The microphone's root-mean-square level (lib/audioLevel.ts) as 0–1 for the orb: nothing below
 * the silence floor, full at a raised voice. Clamped, so a loud room never makes it race.
 */
export function micLevel(rms: number): number {
  if (!Number.isFinite(rms)) return 0;
  return Math.min(1, Math.max(0, (rms - 0.01) / 0.12));
}

/** Eases `current` toward `target` over `dtMs`: quick to rise, slow to fall, so speech reads as a swell, not a flicker. */
export function smoothLevel(current: number, target: number, dtMs: number): number {
  const tau = target > current ? 70 : 320;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  return current + (target - current) * k;
}
