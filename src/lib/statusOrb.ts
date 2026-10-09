import type { OrbLook } from './voiceOrb';

/**
 * The voice sheet's gold dot orb, used outside voice (onboarding): what it shows for each step of
 * reading a roster, and for the Welcome screen's hold. Decoration only; every step is also in words.
 */
export type StatusOrbPhase =
  /** Nothing being read: the Welcome screen at rest, or waiting for the go-ahead. */
  | 'rest'
  /** Reading the file (or the Welcome hold taking things in). */
  | 'working'
  /** Matching the names read to people. */
  | 'connecting'
  /** Finished: a calm, slow ring. */
  | 'done'
  /** An error or a file that couldn't be read: still and dim, next to the message. */
  | 'problem';

const LOOKS: Record<StatusOrbPhase, OrbLook> = {
  rest: { state: 'breathing', alpha: 1, animate: true, speed: 1, audio: false, scale: 1 },
  working: { state: 'working', alpha: 1, animate: true, speed: 1, audio: false, scale: 1 },
  connecting: { state: 'connecting', alpha: 1, animate: true, speed: 1, audio: false, scale: 1 },
  done: { state: 'breathing', alpha: 0.85, animate: true, speed: 0.6, audio: false, scale: 1 },
  problem: { state: 'breathing', alpha: 0.38, animate: false, speed: 0, audio: false, scale: 1 },
};

/** The orb for a step. With reduced motion every step is one still frame. */
export function statusOrbLook(phase: StatusOrbPhase, reducedMotion: boolean): OrbLook {
  const look = LOOKS[phase];
  return reducedMotion ? { ...look, animate: false } : look;
}
