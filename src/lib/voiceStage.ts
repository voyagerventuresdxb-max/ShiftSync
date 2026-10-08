import { voiceAnswer, type ParsedIntent } from '@/api/voice';
import type { VoiceProblem } from '@/lib/voiceErrors';
import type { OrbPhase } from '@/lib/voiceOrb';
import { voiceStepLabel, voiceStepPosition, type VoiceOrigin, type VoiceStep } from '@/lib/voiceSteps';

/**
 * What the full-height voice sheet shows, worked out from AppShell's voice state (which this
 * never changes): one mode, the orb's step, a one-word label, what a screen reader hears, and
 * what the close and microphone buttons do. Pure, so every step and every way out is tested.
 */

export interface VoiceStageState {
  /** Waiting for the microphone (the permission prompt can take seconds). */
  starting: boolean;
  recording: boolean;
  /** Which half of the round trip after a recording is in flight. */
  phase: 'transcribing' | 'understanding' | null;
  /** Closed while a recording was being read: it comes back with the answer, as before. */
  hiddenWhileBusy: boolean;
  /** The typed command box: open, why it opened (if a problem), and whether it is sending. */
  composer: { open: boolean; problem: VoiceProblem | null; sending: boolean };
  /** A reading or an answer on the confirm sheet. */
  result: { intent: ParsedIntent; executed: boolean; hasAdditionalRequest: boolean } | null;
  /** Confirm tapped, the change is being made. */
  executing: boolean;
  /** "Run it" with edited words: the same reading again, no recording. */
  reparsing: boolean;
}

export type VoiceStageMode =
  | 'closed'
  | 'starting'
  | 'listening'
  | 'transcribing'
  | 'understanding'
  /** The keyboard: type a command. */
  | 'typing'
  /** A typed command being read. */
  | 'sending-typed'
  /** Offline, microphone off, timeout, limit… with the typed box to carry on. */
  | 'problem'
  /** The confirm sheet is up (preview, answer, choices, or not understood). */
  | 'result';

export function voiceStageMode(s: VoiceStageState): VoiceStageMode {
  if (s.result) return 'result';
  if (s.starting) return 'starting';
  if (s.recording) return 'listening';
  if (s.phase) return s.hiddenWhileBusy ? 'closed' : s.phase;
  if (s.composer.open) return s.composer.sending ? 'sending-typed' : s.composer.problem ? 'problem' : 'typing';
  return 'closed';
}

/** What kind of sheet a result is, by the same rules VoiceCommandSheet uses to draw it. */
export type VoiceResultKind = 'confirm' | 'answer' | 'choose' | 'unclear' | 'declined' | 'done';

export function voiceResultKind(intent: ParsedIntent, executed: boolean): VoiceResultKind {
  if (intent.intent === 'DECLINED') return 'declined';
  if (intent.intent === 'QUERY_MY_SCHEDULE' || voiceAnswer(intent)) return 'answer';
  if (intent.intent === 'UNRECOGNIZED') {
    // Something to tap (readings, people, close names, the team): a question, not a failure.
    if (intent.options?.length || intent.team?.length || intent.retry?.length) return 'choose';
    return 'unclear';
  }
  return executed ? 'done' : 'confirm';
}

export function voiceOrbPhase(s: VoiceStageState): OrbPhase {
  switch (voiceStageMode(s)) {
    case 'starting':
    case 'typing':
    case 'closed':
      return 'ready';
    case 'listening':
      return 'listening';
    case 'transcribing':
      return 'transcribing';
    case 'understanding':
    case 'sending-typed':
      return 'understanding';
    case 'problem':
      return 'problem';
    case 'result': {
      if (s.executing) return 'sending';
      if (s.reparsing) return 'rereading';
      const kind = voiceResultKind(s.result!.intent, s.result!.executed);
      return kind === 'choose' ? 'choose' : kind === 'unclear' || kind === 'declined' ? 'unclear' : 'confirm';
    }
  }
}

/** The one word under the orb (decorative: the live region and the sheet say the step in full). */
export function voiceStageWord(s: VoiceStageState): string {
  const mode = voiceStageMode(s);
  switch (mode) {
    case 'starting':
      return 'Starting';
    case 'listening':
      return 'Listening';
    case 'transcribing':
      return 'Transcribing';
    case 'understanding':
    case 'sending-typed':
      return 'Understanding';
    case 'typing':
      return 'Ready';
    case 'problem':
    case 'closed':
      return '';
    case 'result': {
      if (s.executing) return 'Sending';
      if (s.reparsing) return 'Understanding';
      const kind = voiceResultKind(s.result!.intent, s.result!.executed);
      return kind === 'confirm' ? 'Ready' : kind === 'answer' ? 'Answered' : kind === 'done' ? 'Done' : kind === 'choose' ? 'Choose' : '';
    }
  }
}

/** The step a screen reader hears from the sheet's live region (the confirm sheet has its own). */
export function voiceStageAnnouncement(s: VoiceStageState): string {
  const mode = voiceStageMode(s);
  if (mode === 'starting') return 'Starting the microphone…';
  const step = stageStep(mode);
  return step ? voiceStepLabel(step) : '';
}

function stageStep(mode: VoiceStageMode): VoiceStep | null {
  return mode === 'listening' ? 'listening' : mode === 'transcribing' ? 'transcribing' : mode === 'understanding' || mode === 'sending-typed' ? 'understanding' : null;
}

/** Where the command is in its sequence, for the small step marks: null when there is no step to show. */
export function voiceStagePosition(s: VoiceStageState, origin: VoiceOrigin): { index: number; total: number } | null {
  const step = stageStep(voiceStageMode(s));
  return step ? voiceStepPosition(step, origin) : null;
}

/**
 * What the close (and Cancel) buttons do in each mode. While recording, closing stops the
 * microphone and sends nothing; while a recording is being read, the sheet hides and comes back
 * with the answer (nothing is cancelled that can't be); while the microphone prompt is up or a
 * typed command is being read, there is nothing to close yet.
 */
export type VoiceCloseAction = 'discard-recording' | 'hide-until-answer' | 'close' | 'none';

export function voiceCloseAction(mode: VoiceStageMode): VoiceCloseAction {
  switch (mode) {
    case 'listening':
      return 'discard-recording';
    case 'transcribing':
    case 'understanding':
      return 'hide-until-answer';
    case 'typing':
    case 'problem':
      return 'close';
    default:
      return 'none';
  }
}

/** The big microphone button: what a tap does and its name (the same words as the dock's mic). */
export function voiceMicControl(mode: VoiceStageMode): { action: 'start' | 'stop' | 'none'; label: string } {
  switch (mode) {
    case 'listening':
      return { action: 'stop', label: 'Stop recording voice command' };
    case 'starting':
      return { action: 'none', label: 'Waiting for microphone permission' };
    case 'transcribing':
    case 'understanding':
    case 'sending-typed':
      return { action: 'none', label: 'Processing voice command' };
    default:
      return { action: 'start', label: 'Start recording a voice command' };
  }
}

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', MANAGER: 'Manager', STAFF: 'Staff' };

/** The line at the top of the sheet: whose venue, in which role ("Venue · Manager"). */
export function voiceContextLine(venueName: string | null, systemRole: string | null | undefined): string {
  const role = systemRole ? (ROLE_LABEL[systemRole] ?? '') : '';
  return [venueName?.trim(), role].filter(Boolean).join(' · ');
}
