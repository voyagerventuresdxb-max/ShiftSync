import { test } from 'node:test';
import assert from 'node:assert/strict';
import { micLevel, orbLook, ORB_PERSONALITIES, smoothLevel, type OrbPhase } from './voiceOrb';

const PHASES: OrbPhase[] = ['ready', 'listening', 'transcribing', 'understanding', 'confirm', 'choose', 'rereading', 'sending', 'unclear', 'problem'];

test('each step has its own shape, as briefed: ready breathes, listening listens, then working, connecting, composing', () => {
  const state = (p: OrbPhase) => orbLook(p, false).state;
  assert.equal(state('ready'), 'breathing');
  assert.equal(state('listening'), 'listening');
  assert.equal(state('transcribing'), 'working');
  assert.equal(state('understanding'), 'connecting');
  assert.equal(state('confirm'), 'breathing');
  assert.equal(state('choose'), 'breathing');
  assert.equal(state('sending'), 'composing');
});

test('never the busy shapes (shaping, weaving, searching, solving)', () => {
  for (const p of PHASES) for (const rm of [false, true]) assert.ok(!['shaping', 'weaving', 'searching', 'solving'].includes(orbLook(p, rm).state), p);
});

test('confirm is a small calm ring; which-one is small and dim; nothing goes wrong loudly', () => {
  const confirm = orbLook('confirm', false);
  assert.ok(confirm.scale < 0.5 && confirm.alpha === 1 && confirm.animate);
  const choose = orbLook('choose', false);
  assert.ok(choose.scale < 0.5 && choose.alpha < 1 && choose.animate);
  // Didn't catch that, offline, microphone off, timeout: a still, dim orb.
  for (const p of ['unclear', 'problem'] as const) {
    const look = orbLook(p, false);
    assert.equal(look.animate, false, p);
    assert.ok(look.alpha < 0.5, p);
  }
});

test('only listening follows the microphone', () => {
  assert.deepEqual(
    PHASES.filter((p) => orbLook(p, false).audio),
    ['listening'],
  );
});

test('reduced motion: every step is one still frame and nothing follows the microphone', () => {
  for (const p of PHASES) {
    const look = orbLook(p, true);
    assert.equal(look.animate, false, p);
    assert.equal(look.audio, false, p);
    // The shape and size still say where the command is up to.
    assert.equal(look.state, orbLook(p, false).state);
    assert.equal(look.scale, orbLook(p, false).scale);
  }
});

test('micLevel: nothing below the silence floor, clamped to 1 when loud, never NaN', () => {
  assert.equal(micLevel(0), 0);
  assert.equal(micLevel(0.005), 0);
  assert.ok(micLevel(0.05) > 0 && micLevel(0.05) < 1);
  assert.equal(micLevel(0.9), 1);
  assert.equal(micLevel(Number.NaN), 0);
  assert.equal(micLevel(Number.POSITIVE_INFINITY), 0);
});

test('smoothLevel rises quicker than it falls and stays between the two values', () => {
  const up = smoothLevel(0, 1, 40);
  const down = 1 - smoothLevel(1, 0, 40);
  assert.ok(up > down, `${up} vs ${down}`);
  for (const dt of [0, 16, 40, 1000]) {
    const v = smoothLevel(0.2, 0.8, dt);
    assert.ok(v >= 0.2 && v <= 0.8);
  }
  assert.equal(smoothLevel(0.5, 0.9, -5), 0.5);
});

test('the two personalities differ in density and motion', () => {
  assert.ok(ORB_PERSONALITIES.b.density > ORB_PERSONALITIES.a.density);
  assert.notEqual(ORB_PERSONALITIES.a.speed, ORB_PERSONALITIES.b.speed);
});
