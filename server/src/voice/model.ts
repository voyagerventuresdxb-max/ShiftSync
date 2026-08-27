/**
 * The single source of truth for which Gemini model the voice pipeline uses.
 *
 * Both halves of the pipeline (transcribe.ts and parseIntent.ts) hit the same
 * model, and previously each read `process.env.VOICE_MODEL` with its own
 * independent hardcoded default — two literals that would silently drift
 * apart the first time one of them was bumped without the other.
 *
 * This is a function rather than a top-level `const` on purpose: the env is
 * read at CALL time, exactly as before, so it still honours a `VOICE_MODEL`
 * set after this module is first imported (dotenv load order, tests).
 */
export const DEFAULT_VOICE_MODEL = 'gemini-3.6-flash';

export function voiceModel(): string {
  return process.env.VOICE_MODEL || DEFAULT_VOICE_MODEL;
}
