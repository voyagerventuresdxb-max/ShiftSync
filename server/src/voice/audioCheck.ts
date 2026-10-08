/**
 * A recording that can't hold a command is turned away before it reaches the transcription model,
 * so it costs nothing: empty, too small to hold any speech, or too big for a short command. For a
 * WAV the length is read from its header too. The app records at most 10 seconds (AppShell).
 */

export const MIN_AUDIO_BYTES = 1024;
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
export const MIN_WAV_SECONDS = 0.3;
export const MAX_WAV_SECONDS = 60;

export interface AudioProblem {
  status: number;
  errorCode: 'voice_audio_too_short' | 'voice_audio_too_long';
  error: string;
}

const TOO_SHORT: AudioProblem = {
  status: 422,
  errorCode: 'voice_audio_too_short',
  error: "I didn't hear anything: the recording was empty or too short. Tap the mic and speak, or type your command below.",
};
const TOO_LONG: AudioProblem = {
  status: 413,
  errorCode: 'voice_audio_too_long',
  error: 'That recording is too long for a voice command. Keep it to a few seconds, or type it below.',
};

/** Seconds of sound in a PCM WAV, from its header; null when it isn't one we can read. */
function wavSeconds(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 16 <= buf.length) byteRate = buf.readUInt32LE(at + 16);
    if (id === 'data') return byteRate > 0 ? Math.min(size, buf.length - at - 8) / byteRate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/** Why this recording is refused before any model call; null when it may be transcribed. */
export function audioProblem(buf: Buffer): AudioProblem | null {
  if (buf.length < MIN_AUDIO_BYTES) return TOO_SHORT;
  if (buf.length > MAX_AUDIO_BYTES) return TOO_LONG;
  const seconds = wavSeconds(buf);
  if (seconds !== null && seconds < MIN_WAV_SECONDS) return TOO_SHORT;
  if (seconds !== null && seconds > MAX_WAV_SECONDS) return TOO_LONG;
  return null;
}
