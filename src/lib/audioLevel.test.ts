import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSilent, METER_INTERVAL_MS, METER_WINDOW_SAMPLES, rms, SILENCE_RMS } from './audioLevel';

test('the level meter reads overlapping windows, so a short word between reads is never missed', () => {
  // Phone microphones run at 44.1 or 48 kHz: each read covers at least two intervals (room for timer jitter).
  for (const rate of [44_100, 48_000]) assert.ok((METER_WINDOW_SAMPLES / rate) * 1000 >= 2 * METER_INTERVAL_MS, `${rate} Hz`);
  // Even at 96 kHz the reads still touch.
  assert.ok((METER_WINDOW_SAMPLES / 96_000) * 1000 >= METER_INTERVAL_MS);
  // A 20 ms sound inside one window still reads well above silence.
  const window = new Float32Array(METER_WINDOW_SAMPLES);
  const burst = Math.round(0.02 * 48_000);
  for (let i = 0; i < burst; i++) window[i] = 0.1 * Math.sin(i / 5);
  assert.ok(!isSilent(rms(window)));
});

test('rms: silence, a faint hiss and speech-level audio', () => {
  assert.equal(rms([]), 0);
  assert.equal(rms(new Float32Array(1000)), 0);
  const hiss = Float32Array.from({ length: 1000 }, (_, i) => (i % 2 ? 0.0005 : -0.0005));
  const speech = Float32Array.from({ length: 1000 }, (_, i) => 0.2 * Math.sin(i / 5));
  assert.ok(isSilent(rms(hiss)));
  assert.ok(!isSilent(rms(speech)));
  assert.ok(rms(speech) > SILENCE_RMS * 10);
});
