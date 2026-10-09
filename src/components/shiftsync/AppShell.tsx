import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CalendarCheck, WifiOff } from 'lucide-react';
import { Link, Outlet, useMatches, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { RadialDock } from '@/components/shiftsync/RadialDock';
import { PanelSkeleton } from '@/components/shiftsync/PanelSkeleton';
import { NotificationBell } from '@/components/shiftsync/NotificationBell';
import { SessionGuard } from '@/components/shiftsync/SessionGuard';
import { useAppState } from '@/state/AppStateContext';
import { useIdentity } from '@/state/IdentityContext';
import { useConnectivity } from '@/state/ConnectivityContext';
import { transcribeAudio, parseVoiceIntent, executeVoiceIntent, isReadIntent, type ParsedIntent } from '@/api/voice';
import { canConfirmVoiceIntent, VOICE_ROLE_REFUSAL } from '../../../shared/voiceIntents';
import { hasVoiceConsent, saveVoiceConsent } from '@/lib/voiceConsent';
import { isSilent, startLevelMeter } from '@/lib/audioLevel';
import { choosableFor } from '@/lib/voiceChoices';
import { BACKGROUNDED, NOTHING_HEARD, UNSUPPORTED, alreadyDone, micProblem, offlineProblem, requestProblem, type VoiceProblem } from '@/lib/voiceErrors';
import { voiceExamples } from '@/lib/voiceExamples';
import type { VoiceOrigin } from '@/lib/voiceSteps';
import { voiceContextLine, voiceStageMode, type VoiceCloseAction, type VoiceStageState } from '@/lib/voiceStage';
// Not lazy: it is what opens when the phone is offline, when a lazy chunk could not be fetched (only its orb loads lazily).
import { VoiceStage } from '@/components/shiftsync/VoiceStage';
import { loadVoiceOrb } from '@/components/shiftsync/voiceOrbChunk';

// Loaded with the first voice result, then kept mounted (its close animation needs it).
// The confirm sheet behind its own reading check and error boundary (both in this lazy chunk).
const VoiceCommandSheet = lazy(() => import('@/components/shiftsync/SafeVoiceCommandSheet').then((m) => ({ default: m.SafeVoiceCommandSheet })));
const VoiceConsentSheet = lazy(() => import('@/components/shiftsync/VoiceCommandSheet').then((m) => ({ default: m.VoiceConsentSheet })));

/**
 * MediaRecorder mimetype candidates, most-preferred first.
 *
 * The list is split in two, strictly: every entry in the first group is in
 * Gemini's documented audio-input list (audio/wav, audio/mp3, audio/aiff,
 * audio/aac, audio/ogg, audio/flac); every entry in the second group is
 * NOT, and is an unconfirmed bet kept only as a fallback.
 *
 * `audio/ogg;codecs=opus` leads because it is the best candidate that is
 * BOTH browser-recordable (Firefox, and Chromium builds that support it)
 * AND documented. The unconfirmed group holds `audio/webm;codecs=opus`
 * (Chrome/Firefox's MediaRecorder default) and `audio/mp4` (Safari's only
 * native recording format) — neither appears in Gemini's documented list,
 * so neither is a better bet than the other and both sort below every
 * documented type. `audio/mp4` previously sat ABOVE the webm entries
 * despite the same "documented first" rationale that demoted webm.
 *
 * They are kept rather than refused outright: a client-side mimetype
 * allowlist that blocks recording entirely on browsers that only support
 * webm (or, for Safari, only mp4) would turn "might not decode"
 * (unverified either way — see server/src/routes/voice.ts's own comment on
 * this) into a guaranteed, silent "voice commands don't work here" for the
 * common case. If the upload genuinely fails to transcribe, that already
 * surfaces as a normal, visible error banner via the existing
 * ApiError/error-block path below — so the "honest failure" this judgment
 * call has to weigh isn't between "silent" and "blocked", it's between
 * "sometimes retry with an error message" and "never try at all for a
 * browser that might have worked".
 */
const RECORDER_MIME_CANDIDATES = [
  // In Gemini's documented audio-input list:
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
  'audio/aac',
  // Not in Gemini's documented list — unconfirmed fallbacks, equal footing:
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

/**
 * Hard stop for a single voice command. Nothing else auto-stops the
 * MediaRecorder, so a tap-and-forget would otherwise record until the tab
 * closed — with the only backstop being multer's 10MB upload cap, which
 * surfaces as a confusing generic "File too large" AFTER the whole
 * recording is discarded.
 *
 * 10s hard cap — matches the product requirement that voice commands stay
 * short and specific; MediaRecorder otherwise records until the tab is
 * closed or stop() is called.
 */
const MAX_RECORDING_MS = 10_000;

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return ''; // no candidate matched — let the browser fall back to its own default rather than refuse to record
}

function isVoiceCapable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

/**
 * Per-route header data, attached to each child route as its `handle`.
 * AppShell is a layout route rendered exactly once for the whole app, so it
 * can't take these as props — it reads them off the active route match.
 */
export interface RouteHandle {
  /** Page title shown in the shell header. */
  title: string;
  /** Optional override for the header's secondary line (defaults to the venue name). */
  eyebrow?: string;
  /** Optional header-right control for this route. */
  action?: ReactNode;
}

function isRouteHandle(handle: unknown): handle is RouteHandle {
  return typeof handle === 'object' && handle !== null && typeof (handle as RouteHandle).title === 'string';
}

/** Starts fetching the voice sheet's orb on the first touch of the mic or keyboard, so it is ready when the sheet opens. */
function warmUpVoice(): void {
  void loadVoiceOrb().catch(() => {});
}

/** First letter of the venue name, for the profile avatar. */
function avatarInitial(venueName: string): string {
  return venueName.trim().charAt(0).toUpperCase() || '·';
}

export function AppShell() {
  // Deepest matched route wins, so a nested route can override its parent's header.
  const matches = useMatches();
  const handle = matches
    .map((match) => match.handle)
    .filter(isRouteHandle)
    .at(-1);

  // `venueName` is the real signed-in venue's actual name (null while
  // loading, or for an anonymous kiosk visit) — never `config.name`, a
  // hardcoded placeholder unrelated to any real venue (see AppStateContext).
  const { venueName } = useAppState();
  const title = handle?.title ?? venueName ?? 'ShiftSync';
  const eyebrow = handle?.eyebrow ?? venueName ?? 'ShiftSync';
  const action = handle?.action;

  const { session } = useIdentity();
  const { online } = useConnectivity();

  // `voiceOn` means "actively recording" (mic armed, first tap already
  // happened); `voiceProcessing` covers the transcribe -> parse-intent
  // round trip after the second tap stops the recording. RadialDock renders
  // a distinct visual for each rather than collapsing them into one boolean.
  const [voiceOn, setVoiceOn] = useState(false);
  // `voiceStarting` covers the gap between the first tap and the mic actually
  // being live — i.e. while the browser's permission prompt is up, which can
  // be seconds on first use. See `voiceStartingRef` below for why both a ref
  // and a state value exist.
  const [voiceStarting, setVoiceStarting] = useState(false);
  // Which half of the round trip is in flight, shown as its own step ("Transcribing…", "Understanding…").
  const [voicePhase, setVoicePhase] = useState<'transcribing' | 'understanding' | null>(null);
  const voiceProcessing = voicePhase !== null;
  const [voiceResult, setVoiceResult] = useState<{
    transcript: string;
    intent: ParsedIntent;
    voiceLogId: string | null;
    hasAdditionalRequest: boolean;
    /** Spoken or typed: the sheet says "I heard" or "You typed". */
    origin: VoiceOrigin;
    /** True once the primary MUTATING intent has actually executed — the sheet stays open in its follow-up state instead of closing. Irrelevant for QUERY_MY_SCHEDULE, which has no execute step. */
    executed?: boolean;
    /** The choices a picked reading came from, so the sheet can go back to them. */
    asked?: ParsedIntent;
  } | null>(null);
  const [voiceExecuting, setVoiceExecuting] = useState(false);
  // The real guard against a second Confirm: two taps in the same instant both pass a state check.
  const voiceExecutingRef = useRef(false);
  const [voiceReparsing, setVoiceReparsing] = useState(false);
  const [voiceSheetNeeded, setVoiceSheetNeeded] = useState(false);
  const [voiceConsentOpen, setVoiceConsentOpen] = useState(false);
  const [voiceConsentNeeded, setVoiceConsentNeeded] = useState(false);
  if (voiceConsentOpen && !voiceConsentNeeded) setVoiceConsentNeeded(true);
  if (voiceResult && !voiceSheetNeeded) setVoiceSheetNeeded(true);
  const [voiceBanner, setVoiceBanner] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  // A Confirm that didn't get through for a passing reason (offline, timeout): shown on the sheet, which stays open.
  const [voiceExecProblem, setVoiceExecProblem] = useState<VoiceProblem | null>(null);
  // The typed command box: opened from the dock, and on every voice problem (with the problem shown above the box).
  const [composer, setComposer] = useState<{ open: boolean; text: string; problem: VoiceProblem | null }>({ open: false, text: '', problem: null });
  const [typedSending, setTypedSending] = useState(false);
  const examples = voiceExamples(session?.user.systemRole ?? 'STAFF');
  // What the recording said, shown on the voice sheet while it is read (display only).
  const [voiceHeard, setVoiceHeard] = useState('');
  // The sheet was closed while a recording was being read: it comes back with the answer, as before.
  const [voiceHidden, setVoiceHidden] = useState(false);
  // The microphone level while recording, for the sheet's orb (read every frame, so a ref).
  const voiceLevelRef = useRef<number | null>(null);
  // Closed while recording: the clip is dropped when the recorder stops, and nothing is sent.
  const discardRecordingRef = useRef(false);

  /** Opens the typed command box, with what went wrong (if anything) and the words so far. */
  const openComposer = useCallback((problem: VoiceProblem | null, text = '') => {
    setVoiceBanner(null);
    setComposer({ open: true, text, problem });
  }, []);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  /**
   * The real double-tap guard, deliberately a ref and not the `voiceStarting`
   * state: a second tap can land in the same tick as the first, before React
   * has re-rendered with the new state, and both calls would then sail past a
   * state-based check. Two concurrent `getUserMedia` calls both resolve,
   * `mediaRecorderRef` can only hold one of them, and the loser's MediaStream
   * stays open with nothing left able to stop it — the tab's mic indicator
   * stays lit until a reload. The state value exists only to drive the
   * button's disabled/visual treatment.
   */
  const voiceStartingRef = useRef(false);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearMaxDurationTimer = useCallback(() => {
    if (maxDurationTimerRef.current !== null) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
  }, []);

  // Stop released the tab's mic indicator too, not just our own state —
  // matters if the user navigates away mid-recording (AppShell itself never
  // unmounts, since it's the layout route, but this is cheap insurance).
  useEffect(() => {
    return () => {
      if (maxDurationTimerRef.current !== null) clearTimeout(maxDurationTimerRef.current);
      mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /**
   * Shows a parse result: the role check BEFORE the confirm sheet (a STAFF session must never be
   * shown a "Confirm" for a manager action the server would refuse anyway — the server's 403 on
   * /execute stays the real guard; the parse step refuses it too, with this same shared reason),
   * then only the choices this role may confirm.
   */
  const showParsed = useCallback(
    (
      systemRole: string,
      transcript: string,
      parsed: { intent: ParsedIntent; voiceLogId: string | null; hasAdditionalRequest: boolean },
      origin: VoiceOrigin,
    ) => {
      const { intent, voiceLogId, hasAdditionalRequest } = parsed;
      const refusedForRole = intent.intent === 'UNRECOGNIZED' && intent.reason === VOICE_ROLE_REFUSAL;
      // Answers and "not by voice" are never confirmed or executed, so there is no action to check.
      const nothingToConfirm = intent.intent === 'UNRECOGNIZED' || intent.intent === 'DECLINED' || isReadIntent(intent);
      setVoiceExecProblem(null);
      if (refusedForRole || (!nothingToConfirm && !canConfirmVoiceIntent(systemRole, intent.intent))) {
        setVoiceResult(null);
        setVoiceBanner({ kind: 'error', message: VOICE_ROLE_REFUSAL });
        return;
      }
      setVoiceResult({ transcript, intent: choosableFor(systemRole, intent), voiceLogId, hasAdditionalRequest, origin });
    },
    [],
  );

  const handleRecordingComplete = useCallback(
    async (blob: Blob) => {
      if (blob.size === 0) {
        openComposer(NOTHING_HEARD);
        return;
      }
      if (!session) {
        // Session could have expired mid-recording; re-check rather than
        // send a doomed request that would only surface as a bare 401.
        setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
        return;
      }
      setVoicePhase('transcribing');
      setVoiceHeard('');
      let transcript = '';
      try {
        ({ transcript } = await transcribeAudio(session.token, blob));
        setVoiceHeard(transcript);
        setVoicePhase('understanding');
        showParsed(session.user.systemRole, transcript, await parseVoiceIntent(session.token, transcript, 'voice'), 'voice');
      } catch (err) {
        // Whatever was heard is kept in the box, so it can be sent again by typing.
        openComposer(requestProblem(err, { stage: 'understand', online: navigator.onLine }), transcript);
      } finally {
        setVoicePhase(null);
        setVoiceHidden(false);
      }
    },
    [session, showParsed, openComposer],
  );

  // "Update preview" on the sheet with the words as edited: the same parse step as a recording, from
  // the text alone (nothing is recorded or transcribed). Nothing runs until its own Confirm.
  const handleVoiceReparse = useCallback(
    async (text: string) => {
      if (!session) {
        setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
        setVoiceResult(null);
        return;
      }
      const origin = voiceResult?.origin ?? 'voice';
      setVoiceReparsing(true);
      try {
        showParsed(session.user.systemRole, text, await parseVoiceIntent(session.token, text, 'typed'), origin);
      } catch (err) {
        setVoiceResult(null);
        openComposer(requestProblem(err, { stage: 'understand', online: navigator.onLine }), text);
      } finally {
        setVoiceReparsing(false);
      }
    },
    [session, showParsed, openComposer, voiceResult?.origin],
  );

  /** A typed command: the same reading, preview and Confirm as a spoken one, without recording anything. */
  const handleTypedSend = useCallback(
    async (text: string) => {
      if (!session) {
        setComposer((c) => ({ ...c, problem: { kind: 'failed', title: 'Sign in first', message: 'Sign in to use voice commands.' } }));
        return;
      }
      setTypedSending(true);
      setComposer((c) => ({ ...c, text, problem: null }));
      try {
        const parsed = await parseVoiceIntent(session.token, text, 'typed');
        setComposer({ open: false, text: '', problem: null });
        showParsed(session.user.systemRole, text, parsed, 'typed');
      } catch (err) {
        // Offline is refused before anything is sent (api/voice.ts); the words stay in the box either way.
        setComposer({ open: true, text, problem: requestProblem(err, { stage: 'understand', online: navigator.onLine }) });
      } finally {
        setTypedSending(false);
      }
    },
    [session, showParsed],
  );

  const handleComposerCancel = useCallback(() => setComposer({ open: false, text: '', problem: null }), []);
  const handleComposerChange = useCallback((text: string) => setComposer((c) => ({ ...c, text })), []);
  const handleOpenComposer = useCallback(() => openComposer(null), [openComposer]);

  /** The single stop-and-process path — a manual second tap and the max-duration timer both land here. */
  const stopVoiceRecording = useCallback(() => {
    clearMaxDurationTimer();
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setVoiceOn(false);
  }, [clearMaxDurationTimer]);

  useEffect(() => {
    // An app switch or a locked screen while recording: the microphone goes off and the clip is
    // dropped unsent, as when the sheet is closed; the sheet says so when the app comes back.
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden' || !mediaRecorderRef.current) return;
      discardRecordingRef.current = true;
      stopVoiceRecording();
      openComposer(BACKGROUNDED);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stopVoiceRecording, openComposer]);

  const startVoiceRecording = useCallback(async () => {
    // Synchronous guard first: everything below this line is async, and a
    // second tap during the permission prompt must be a hard no-op.
    if (voiceStartingRef.current) return;
    if (!session) {
      setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
      return;
    }
    if (!isVoiceCapable()) {
      openComposer(UNSUPPORTED);
      return;
    }
    setVoiceBanner(null);
    setVoiceHeard('');
    voiceStartingRef.current = true;
    setVoiceStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
      // The app went to the background while the microphone was starting: let it go at once.
      if (document.visibilityState === 'hidden') {
        stream.getTracks().forEach((t) => t.stop());
        openComposer(BACKGROUNDED);
        return;
      }
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const meter = startLevelMeter(stream, (level) => {
        voiceLevelRef.current = level;
      });
      audioChunksRef.current = [];
      discardRecordingRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const peak = meter.stop();
        stream.getTracks().forEach((t) => t.stop());
        voiceLevelRef.current = null;
        // Closed while recording: the microphone is off and nothing is sent.
        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          audioChunksRef.current = [];
          return;
        }
        const finalType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: finalType });
        audioChunksRef.current = [];
        // A silent clip is never sent (see lib/audioLevel.ts).
        if (peak !== null && isSilent(peak)) {
          openComposer(NOTHING_HEARD);
          return;
        }
        void handleRecordingComplete(blob);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceOn(true);
      // Auto-stop through the exact same path a manual second tap takes, so a
      // tap-and-forget still produces a normal, processable recording.
      clearMaxDurationTimer();
      maxDurationTimerRef.current = setTimeout(() => {
        maxDurationTimerRef.current = null;
        stopVoiceRecording();
      }, MAX_RECORDING_MS);
    } catch (err) {
      // Denied (with how to turn it back on), missing or busy: each said plainly, with the typed box.
      openComposer(micProblem(err));
    } finally {
      // Cleared on BOTH paths — a denied/failed prompt must leave the button
      // tappable again, not permanently stuck in the "starting" state.
      voiceStartingRef.current = false;
      setVoiceStarting(false);
    }
  }, [session, handleRecordingComplete, clearMaxDurationTimer, stopVoiceRecording, openComposer]);

  const handleToggleVoice = useCallback(() => {
    // Both already disable the button itself; guarded here too against a stray
    // keyboard activation (and, for `voiceStarting`, a same-tick double tap).
    if (voiceProcessing || voiceStarting) return;
    if (voiceOn) {
      stopVoiceRecording();
    } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Nothing recorded that couldn't be sent: say so straight away.
      openComposer(offlineProblem('record'));
    } else if (session && !hasVoiceConsent(session.user.id)) {
      setVoiceConsentOpen(true);
    } else {
      void startVoiceRecording();
    }
  }, [voiceOn, voiceProcessing, voiceStarting, session, startVoiceRecording, stopVoiceRecording, openComposer]);

  const handleVoiceConsentAccept = useCallback(() => {
    setVoiceConsentOpen(false);
    if (session) saveVoiceConsent(session.user.id);
    void startVoiceRecording();
  }, [session, startVoiceRecording]);

  const handleVoiceConsentCancel = useCallback(() => setVoiceConsentOpen(false), []);

  /** The voice sheet's mic is the dock's: from the typed box, the box gives way to the recording. */
  const handleStageMic = useCallback(() => {
    if (composer.open && !voiceOn) setComposer((c) => ({ ...c, open: false }));
    handleToggleVoice();
  }, [composer.open, voiceOn, handleToggleVoice]);

  /** The voice sheet's close and Cancel: which one applies comes from lib/voiceStage.ts. */
  const handleStageClose = useCallback(
    (action: VoiceCloseAction) => {
      if (action === 'discard-recording') {
        // The recorder stops, the microphone is released, and the clip is dropped unsent.
        discardRecordingRef.current = true;
        stopVoiceRecording();
      } else if (action === 'hide-until-answer') {
        setVoiceHidden(true);
      } else if (action === 'close') {
        handleComposerCancel();
      }
    },
    [stopVoiceRecording, handleComposerCancel],
  );

  const handleVoiceCancel = useCallback(() => {
    setVoiceResult(null);
    setVoiceExecProblem(null);
  }, []);

  // A reading the sheet can't draw, or an error while drawing it: the sheet closes, the words go back in the box.
  const voiceTranscript = voiceResult?.transcript ?? '';
  const handleVoiceUnreadable = useCallback(
    (problem: VoiceProblem) => {
      setVoiceResult(null);
      setVoiceExecProblem(null);
      openComposer(problem, voiceTranscript);
    },
    [voiceTranscript, openComposer],
  );

  // A "which did you mean?" choice only swaps in that reading; its own Confirm still executes it.
  const handleVoiceChoose = useCallback((option: ParsedIntent) => {
    setVoiceExecProblem(null);
    setVoiceResult((prev) => (prev ? { ...prev, intent: option, asked: prev.asked ?? prev.intent } : prev));
  }, []);

  const handleVoiceBackToChoices = useCallback(() => {
    setVoiceResult((prev) => (prev?.asked ? { ...prev, intent: prev.asked, asked: undefined } : prev));
  }, []);

  const handleVoiceConfirm = useCallback(async () => {
    if (!voiceResult || voiceExecutingRef.current) return;
    if (!session) {
      setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
      setVoiceResult(null);
      return;
    }
    voiceExecutingRef.current = true;
    setVoiceExecuting(true);
    setVoiceExecProblem(null);
    const done = () => {
      if (voiceResult.hasAdditionalRequest) {
        // Keep the sheet open, transitioned into its follow-up state
        // (VoiceCommandSheet's `executed` prop) — the sheet's own "Done: …"
        // copy plus the follow-up prompt already communicate completion, so
        // no separate success banner fires for this path.
        setVoiceResult({ ...voiceResult, executed: true });
      } else {
        setVoiceBanner({ kind: 'success', message: `Done: ${voiceResult.intent.summary}` });
        setVoiceResult(null);
      }
    };
    try {
      await executeVoiceIntent(session.token, voiceResult.transcript, voiceResult.intent, voiceResult.voiceLogId);
      done();
    } catch (err) {
      // A Confirm tapped again after a timeout or a dropped connection, for a command the first
      // tap already did: the server runs it once and says so, which is success, not an error.
      if (alreadyDone(err)) {
        done();
        return;
      }
      const problem = requestProblem(err, { stage: 'execute', online: navigator.onLine });
      if (problem.kind === 'offline' || problem.kind === 'timeout') {
        // Passing trouble: the sheet stays open with the reason, so Confirm can be tapped again.
        setVoiceExecProblem(problem);
      } else {
        setVoiceBanner({ kind: 'error', message: `${problem.title}: ${problem.message}` });
        setVoiceResult(null);
      }
    } finally {
      voiceExecutingRef.current = false;
      setVoiceExecuting(false);
    }
  }, [voiceResult, session]);

  // My Shifts is the staff-facing home screen, so it needs a real destination
  // in the shell chrome exactly like /profile has — the four-tab RadialDock is
  // the manager-side nav and has no room for it.
  const onMyShifts = useLocation().pathname === '/my-shifts';

  const stageState: VoiceStageState = {
    starting: voiceStarting,
    recording: voiceOn,
    phase: voicePhase,
    hiddenWhileBusy: voiceHidden,
    composer: { open: composer.open, problem: composer.problem, sending: typedSending },
    result: voiceResult ? { intent: voiceResult.intent, executed: voiceResult.executed ?? false, hasAdditionalRequest: voiceResult.hasAdditionalRequest } : null,
    executing: voiceExecuting,
    reparsing: voiceReparsing,
  };
  // While the voice sheet is open, everything behind it is out of reach (screen readers, Tab, taps).
  const stageOpen = voiceStageMode(stageState) !== 'closed';
  const stageWasOpen = useRef(false);
  // The dock button that opened the sheet (the page behind goes inert while it is open, so it is noted at the tap).
  const voiceOpenerRef = useRef<HTMLElement | null>(null);
  const fromDock = (open: () => void) => () => {
    const el = document.activeElement;
    voiceOpenerRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
    open();
  };
  useEffect(() => {
    // Closed: focus goes back to the button that opened it (or the mic), unless something else already has it.
    if (stageWasOpen.current && !stageOpen && (!document.activeElement || document.activeElement === document.body)) {
      const opener = voiceOpenerRef.current?.isConnected ? voiceOpenerRef.current : document.querySelector<HTMLElement>('[data-voice-entry]');
      opener?.focus({ preventScroll: true });
    }
    stageWasOpen.current = stageOpen;
  }, [stageOpen]);

  return (
    <div className="min-h-dvh bg-background pb-[calc(6rem+env(safe-area-inset-bottom))]">
      <header inert={stageOpen} className="sticky top-0 z-20 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-4">
        <div className="glass-bar mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl px-3 py-2.5 shadow-lux sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to="/profile"
              aria-label="Open your profile"
              className="hit-44 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-sm font-bold text-accent transition-transform duration-200 hover:scale-105 active:scale-95"
            >
              {avatarInitial(venueName ?? 'ShiftSync')}
            </Link>

            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight">{title}</p>
              <p className="truncate text-[11px] text-muted-foreground">{eyebrow}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {action}
            <Link
              to="/my-shifts"
              aria-label="Open My Shifts"
              aria-current={onMyShifts ? 'page' : undefined}
              className={cn(
                'hit-44 grid h-9 w-9 place-items-center rounded-full border transition-all duration-300',
                onMyShifts
                  ? 'glow-gold border-accent/50 bg-accent/15 text-accent'
                  : 'border-border text-foreground/40 hover:text-foreground/70',
              )}
            >
              <CalendarCheck className="h-4 w-4" strokeWidth={onMyShifts ? 2.4 : 1.6} />
            </Link>
            <NotificationBell />
          </div>
        </div>
      </header>

      {!online && (
        <div inert={stageOpen} className="mx-auto mt-2.5 max-w-6xl px-3 sm:px-4" role="status">
          <div className="flex items-center justify-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-center text-xs font-medium text-warning">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            You're offline — some actions are unavailable until your connection returns.
          </div>
        </div>
      )}

      <main inert={stageOpen} className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        <SessionGuard />
        <Suspense fallback={<PanelSkeleton />}>
          <Outlet />
        </Suspense>
      </main>

      {voiceBanner && (
        <div className="fixed inset-x-0 bottom-24 z-40 mx-auto w-full max-w-sm px-4">
          <div className={voiceBanner.kind === 'error' ? 'error-block' : 'success-block'} role={voiceBanner.kind === 'error' ? 'alert' : 'status'}>
            <p>{voiceBanner.message}</p>
            <button className="btn btn-ghost" onClick={() => setVoiceBanner(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {stageOpen && (
        <VoiceStage
          state={stageState}
          context={voiceContextLine(venueName, session?.user.systemRole)}
          heard={voiceHeard}
          level={voiceLevelRef}
          composerText={composer.text}
          examples={examples}
          onComposerChange={handleComposerChange}
          onSend={handleTypedSend}
          onMic={handleStageMic}
          onClose={handleStageClose}
        >
          {voiceSheetNeeded && voiceResult && (
            <Suspense fallback={null}>
              <VoiceCommandSheet
                intent={voiceResult.intent}
                transcript={voiceResult.transcript}
                hasAdditionalRequest={voiceResult.hasAdditionalRequest}
                executed={voiceResult.executed ?? false}
                onConfirm={handleVoiceConfirm}
                onChoose={handleVoiceChoose}
                onBackToChoices={voiceResult.asked ? handleVoiceBackToChoices : undefined}
                onReparse={handleVoiceReparse}
                onCancel={handleVoiceCancel}
                executing={voiceExecuting}
                reparsing={voiceReparsing}
                viewerName={session?.user.fullName ?? 'You'}
                canManageStaff={session?.user.systemRole === 'MANAGER' || session?.user.systemRole === 'OWNER'}
                origin={voiceResult.origin}
                examples={examples}
                problem={voiceExecProblem}
                onUnreadable={handleVoiceUnreadable}
              />
            </Suspense>
          )}
        </VoiceStage>
      )}

      {voiceConsentNeeded && (
        <Suspense fallback={null}>
          <VoiceConsentSheet open={voiceConsentOpen} onAccept={handleVoiceConsentAccept} onCancel={handleVoiceConsentCancel} />
        </Suspense>
      )}

      <RadialDock
        listening={voiceOn}
        starting={voiceStarting}
        processing={voiceProcessing}
        onToggleListening={fromDock(handleToggleVoice)}
        onType={fromDock(handleOpenComposer)}
        typeDisabled={voiceOn || voiceStarting || voiceProcessing}
        concealed={stageOpen}
        onWarmUp={warmUpVoice}
      />
    </div>
  );
}
