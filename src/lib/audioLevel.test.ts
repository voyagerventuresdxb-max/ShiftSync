import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSilent, rms, SILENCE_RMS } from './audioLevel';

test('rms: silence, a faint hiss and speech-level audio', () => {
  assert.equal(rms([]), 0);
  assert.equal(rms(new Float32Array(1000)), 0);
  const hiss = Float32Array.from({ length: 1000 }, (_, i) => (i % 2 ? 0.0005 : -0.0005));
  const speech = Float32Array.from({ length: 1000 }, (_, i) => 0.2 * Math.sin(i / 5));
  assert.ok(isSilent(rms(hiss)));
  assert.ok(!isSilent(rms(speech)));
  assert.ok(rms(speech) > SILENCE_RMS * 10);
});
