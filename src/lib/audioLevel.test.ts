import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { isSilent, METER_INTERVAL_MS, METER_WINDOW_SAMPLES, rms, SILENCE_RMS, startLevelMeter } from './audioLevel';

/** Runs `startLevelMeter` against a fake AudioContext in `state` whose analyser reads `level`. */
function meterPeak(state: 'running' | 'suspended', level: number, onLevel?: (rms: number) => void): number | null {
  class FakeContext {
    state = state;
    createAnalyser() {
      return { fftSize: 0, getFloatTimeDomainData: (buf: Float32Array) => buf.fill(level) };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    close() {
      return Promise.resolve();
    }
  }
  const g = globalThis as { window?: unknown };
  const saved = g.window;
  g.window = { AudioContext: FakeContext };
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const meter = startLevelMeter({} as MediaStream, onLevel);
    mock.timers.tick(METER_INTERVAL_MS * 5);
    return meter.stop();
  } finally {
    mock.timers.reset();
    g.window = saved;
  }
}

test('each reading is passed on as it is taken (the orb follows it), without changing the silence check', () => {
  const heard: number[] = [];
  assert.equal(meterPeak('running', 0.25, (l) => heard.push(l)), 0.25);
  assert.deepEqual(heard, [0.25, 0.25, 0.25, 0.25, 0.25]);
  // A suspended context reads nothing, so nothing is passed on either.
  const none: number[] = [];
  assert.equal(meterPeak('suspended', 0.2, (l) => none.push(l)), null);
  assert.deepEqual(none, []);
});

test('a suspended audio context measures nothing, so the clip is never blocked as silent', () => {
  // Some browsers start an AudioContext suspended until a user gesture; its analyser reads only zeros.
  assert.equal(meterPeak('suspended', 0), null);
  assert.equal(meterPeak('running', 0), 0);
  assert.ok(!isSilent(meterPeak('running', 0.2)!));
});

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
