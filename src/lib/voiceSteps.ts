/**
 * The steps of one voice (or typed) command, in order, with the words shown for each. A spoken
 * change goes Listening → Transcribing → Understanding → Ready to confirm → Doing it → Done; a
 * typed one starts at Understanding; a read ends at the answer (nothing to confirm or do).
 */
export type VoiceStep = 'listening' | 'transcribing' | 'understanding' | 'ready' | 'answered' | 'doing' | 'done';

export type VoiceOrigin = 'voice' | 'typed';

export function voiceSteps(origin: VoiceOrigin, kind: 'change' | 'read' = 'change'): VoiceStep[] {
  const heard: VoiceStep[] = origin === 'voice' ? ['listening', 'transcribing'] : [];
  return kind === 'read' ? [...heard, 'understanding', 'answered'] : [...heard, 'understanding', 'ready', 'doing', 'done'];
}

const LABEL: Record<VoiceStep, string> = {
  listening: 'Listening… tap the mic to stop',
  transcribing: 'Transcribing…',
  understanding: 'Understanding…',
  ready: 'Ready to confirm',
  answered: "Here's the answer",
  doing: 'Doing it…',
  done: 'Done',
};

export function voiceStepLabel(step: VoiceStep): string {
  return LABEL[step];
}

/** Where `step` sits in its sequence: 1-based position and the total, for the progress bar. */
export function voiceStepPosition(step: VoiceStep, origin: VoiceOrigin, kind: 'change' | 'read' = 'change'): { index: number; total: number } {
  const steps = voiceSteps(origin, kind);
  return { index: steps.indexOf(step) + 1, total: steps.length };
}
