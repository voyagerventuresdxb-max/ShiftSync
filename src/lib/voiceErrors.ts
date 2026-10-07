import { ApiError, VoiceOfflineError, VoiceTimeoutError } from '@/api/voice';

/**
 * What went wrong with a voice command, in words for the person holding the phone: a short title,
 * one plain sentence, and (for a blocked microphone) how to turn it back on. Every one of these is
 * shown next to the typed command box, so the person can always carry on by typing.
 */
export interface VoiceProblem {
  kind: 'mic_denied' | 'mic_missing' | 'mic_failed' | 'unsupported' | 'offline' | 'timeout' | 'unavailable' | 'limit' | 'no_speech' | 'failed';
  title: string;
  message: string;
  /** Steps to fix it, one per line. */
  help?: string[];
}

/** Before the request (understanding what was said) or after Confirm (doing it). Changes what "nothing changed" can promise. */
export type VoiceStage = 'understand' | 'execute';

/** Steps to re-enable the microphone for this site on an iPhone, where most staff use the app. */
export const IPHONE_MIC_HELP = [
  'On iPhone (Safari): tap “aA” in the address bar, then Website Settings → Microphone → Allow, and reload the page.',
  'Still blocked? Open Settings → Apps → Safari → Microphone (Settings → Safari on older iPhones) and choose Ask or Allow.',
];

/** A failed `getUserMedia` (the browser's microphone request). */
export function micProblem(err: unknown): VoiceProblem {
  const name = err instanceof Error || (typeof err === 'object' && err !== null && 'name' in err) ? String((err as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return {
      kind: 'mic_denied',
      title: 'Microphone is off',
      message: "ShiftSync isn't allowed to use the microphone, so nothing was recorded. Type your command below instead.",
      help: IPHONE_MIC_HELP,
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { kind: 'mic_missing', title: 'No microphone found', message: 'This device has no microphone ShiftSync can use. Type your command below instead.' };
  }
  return {
    kind: 'mic_failed',
    title: "Microphone didn't start",
    message: 'Another app may be using it. Close that app and try again, or type your command below.',
  };
}

export const UNSUPPORTED: VoiceProblem = {
  kind: 'unsupported',
  title: "Voice doesn't work here",
  message: "This browser can't record voice commands. Type your command below instead.",
};

/** A recording with nothing in it: never sent (see lib/audioLevel.ts). */
export const NOTHING_HEARD: VoiceProblem = {
  kind: 'no_speech',
  title: "Didn't hear anything",
  message: "I didn't hear anything. Hold the phone a little closer and try again, or type your command below.",
};

/** Offline before anything was recorded or sent. */
export function offlineProblem(stage: VoiceStage | 'record'): VoiceProblem {
  const message =
    stage === 'record'
      ? 'Voice needs a connection, so nothing was recorded. Reconnect and try again.'
      : stage === 'execute'
        ? 'Nothing was sent and nothing changed. Reconnect, then tap Confirm again.'
        : 'Nothing was sent. Reconnect, then send it again — your words are kept below.';
  return { kind: 'offline', title: "You're offline", message };
}

/** "Request failed (503)": the server said nothing more useful than its status. */
const GENERIC = /^Request failed \(\d+\)$/;

/** A failed transcribe / parse-intent / execute call, as a VoiceProblem. `online` is `navigator.onLine` at the time. */
export function requestProblem(err: unknown, { stage, online }: { stage: VoiceStage; online: boolean }): VoiceProblem {
  if (err instanceof VoiceOfflineError) {
    if (!err.sent || !online) return offlineProblem(stage);
    return {
      kind: 'offline',
      title: "Can't reach ShiftSync",
      message:
        stage === 'execute'
          ? "The connection dropped. It may still have gone through — check before you confirm again."
          : 'The connection dropped before an answer came back. Check your signal and send it again.',
    };
  }
  if (err instanceof VoiceTimeoutError) {
    const seconds = err.seconds === 1 ? '1 second' : `${err.seconds} seconds`;
    return {
      kind: 'timeout',
      title: 'Taking too long',
      message:
        stage === 'execute'
          ? `No answer after ${seconds}. It may still have gone through — check before you confirm again.`
          : `The assistant didn't answer within ${seconds}, so I stopped waiting. Nothing changed. Try again, or type it below.`,
    };
  }
  if (err instanceof ApiError) {
    const own = GENERIC.test(err.message) ? null : err.message;
    // The spend cap answers 503 with errorCode ai_paused: that is a limit, not an outage.
    if (err.status === 429 || err.errorCode === 'ai_paused') {
      return { kind: 'limit', title: 'Limit reached', message: own ?? "You've reached the limit for voice commands for now. Try again later." };
    }
    if (err.status === 503) {
      return {
        kind: 'unavailable',
        title: 'Assistant unavailable',
        message: own ?? "The voice assistant isn't available right now. Nothing changed — try again in a few minutes.",
      };
    }
    if (err.status === 422 && err.errorCode === 'voice_no_speech') {
      return { kind: 'no_speech', title: "Didn't hear a command", message: err.message };
    }
    return { kind: 'failed', title: stage === 'execute' ? "Didn't go through" : "Couldn't read that", message: err.message };
  }
  return {
    kind: 'failed',
    title: stage === 'execute' ? "Didn't go through" : "Couldn't read that",
    message: stage === 'execute' ? 'Could not execute the voice command.' : 'Could not process the voice command.',
  };
}
