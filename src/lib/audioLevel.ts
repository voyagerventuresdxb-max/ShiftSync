/**
 * Microphone level while a voice command records. A clip that stayed silent is not sent: in
 * evaluation, a silent clip came back from the transcriber as an invented command built from
 * the venue's names.
 */

/** Below this root-mean-square level (about -40 dBFS) for the whole recording, nobody spoke. */
export const SILENCE_RMS = 0.01;

export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

export function isSilent(peakRms: number): boolean {
  return peakRms < SILENCE_RMS;
}

/**
 * How often the level is read, and how many samples each read covers. Each read must reach back
 * past the previous one, so a short word between reads is never missed.
 */
export const METER_INTERVAL_MS = 40;
export const METER_WINDOW_SAMPLES = 4096;

/**
 * Samples the stream's level every `METER_INTERVAL_MS`. `stop()` returns the loudest moment's
 * RMS, or null when the browser can't measure (then nothing is blocked).
 */
export function startLevelMeter(stream: MediaStream): { stop: () => number | null } {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return { stop: () => null };
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = METER_WINDOW_SAMPLES;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    let measured = false;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      peak = Math.max(peak, rms(buf));
      measured = true;
    }, METER_INTERVAL_MS);
    return {
      stop: () => {
        clearInterval(timer);
        void ctx.close().catch(() => {});
        return measured ? peak : null;
      },
    };
  } catch {
    return { stop: () => null };
  }
}
