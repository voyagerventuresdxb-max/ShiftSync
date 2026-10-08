import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusOrbLook, type StatusOrbPhase } from './statusOrb';

test('reading is "working", matching is "connecting", finished is a slow calm ring, a problem is still and dim', () => {
  assert.equal(statusOrbLook('working', false).state, 'working');
  assert.equal(statusOrbLook('connecting', false).state, 'connecting');
  const done = statusOrbLook('done', false);
  assert.equal(done.state, 'breathing');
  assert.ok(done.animate && done.speed < 1);
  const problem = statusOrbLook('problem', false);
  assert.equal(problem.animate, false);
  assert.ok(problem.alpha < 0.5);
});

test('never follows a microphone, and every step is one still frame with reduced motion', () => {
  for (const phase of ['rest', 'working', 'connecting', 'done', 'problem'] as StatusOrbPhase[]) {
    assert.equal(statusOrbLook(phase, false).audio, false, phase);
    assert.equal(statusOrbLook(phase, true).animate, false, phase);
    assert.equal(statusOrbLook(phase, true).state, statusOrbLook(phase, false).state, phase);
  }
});
