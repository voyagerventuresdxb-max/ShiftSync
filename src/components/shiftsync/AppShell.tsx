import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, CalendarCheck } from 'lucide-react';
import { Link, Outlet, useMatches, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { RadialDock } from '@/components/shiftsync/RadialDock';
import { VoiceCommandSheet } from '@/components/shiftsync/VoiceCommandSheet';
import { useAppState } from '@/state/AppStateContext';
import { useIdentity } from '@/state/IdentityContext';
import { transcribeAudio, parseVoiceIntent, executeVoiceIntent, ApiError, type ParsedIntent } from '@/api/voice';

/**
 * MediaRecorder mimetype candidates, most-preferred first.
 *
 * Gemini's documented audio-input formats do NOT include `audio/webm`, but
 * `audio/webm;codecs=opus` is what Chrome/Firefox's MediaRecorder defaults
 * to. `audio/ogg;codecs=opus` is the best candidate that is BOTH
 * browser-recordable (Firefox, and Chromium builds that support it) AND in
 * Gemini's documented list (audio/wav, audio/mp3, audio/aiff, audio/aac,
 * audio/ogg, audio/flac) — so it is tried first. The webm variants are kept
 * as a last-resort fallback rather than refused outright: a client-side
 * mimetype allowlist that blocks recording entirely on browsers that only
 * support webm would turn "might not decode" (unverified either way — see
 * server/src/routes/voice.ts's own comment on this) into a guaranteed,
 * silent "voice commands don't work here" for the common case. If the
 * upload genuinely fails to transcribe, that already surfaces as a normal,
 * visible error banner via the existing ApiError/error-block path below —
 * so the "honest failure" this judgment call has to weigh isn't between
 * "silent" and "blocked", it's between "sometimes retry with an error
 * message" and "never try at all for a browser that might have worked".
 */
const RECORDER_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
  'audio/aac',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];

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

  const { config } = useAppState();
  const title = handle?.title ?? config.name;
  const eyebrow = handle?.eyebrow ?? config.name;
  const action = handle?.action;

  const { session } = useIdentity();

  // `voiceOn` means "actively recording" (mic armed, first tap already
  // happened); `voiceProcessing` covers the transcribe -> parse-intent
  // round trip after the second tap stops the recording. RadialDock renders
  // a distinct visual for each rather than collapsing them into one boolean.
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [voiceResult, setVoiceResult] = useState<{ transcript: string; intent: ParsedIntent } | null>(null);
  const [voiceExecuting, setVoiceExecuting] = useState(false);
  const [voiceBanner, setVoiceBanner] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Stop released the tab's mic indicator too, not just our own state —
  // matters if the user navigates away mid-recording (AppShell itself never
  // unmounts, since it's the layout route, but this is cheap insurance).
  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handleRecordingComplete = useCallback(
    async (blob: Blob) => {
      if (blob.size === 0) {
        setVoiceBanner({ kind: 'error', message: 'No audio captured — try again.' });
        return;
      }
      if (!session) {
        // Session could have expired mid-recording; re-check rather than
        // send a doomed request that would only surface as a bare 401.
        setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
        return;
      }
      setVoiceProcessing(true);
      try {
        const { transcript } = await transcribeAudio(session.token, blob);
        const { intent } = await parseVoiceIntent(session.token, transcript);
        setVoiceResult({ transcript, intent });
      } catch (err) {
        setVoiceBanner({ kind: 'error', message: err instanceof ApiError ? err.message : 'Could not process the voice command.' });
      } finally {
        setVoiceProcessing(false);
      }
    },
    [session],
  );

  const startVoiceRecording = useCallback(async () => {
    if (!session) {
      setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
      return;
    }
    if (!isVoiceCapable()) {
      setVoiceBanner({ kind: 'error', message: 'Voice commands are not supported in this browser.' });
      return;
    }
    setVoiceBanner(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const finalType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: finalType });
        audioChunksRef.current = [];
        void handleRecordingComplete(blob);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceOn(true);
    } catch {
      setVoiceBanner({ kind: 'error', message: 'Microphone access was denied or unavailable.' });
    }
  }, [session, handleRecordingComplete]);

  const stopVoiceRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setVoiceOn(false);
  }, []);

  const handleToggleVoice = useCallback(() => {
    if (voiceProcessing) return; // already disabled on the button itself; guarded here too against a stray keyboard activation
    if (voiceOn) {
      stopVoiceRecording();
    } else {
      void startVoiceRecording();
    }
  }, [voiceOn, voiceProcessing, startVoiceRecording, stopVoiceRecording]);

  const handleVoiceCancel = useCallback(() => {
    setVoiceResult(null);
  }, []);

  const handleVoiceConfirm = useCallback(async () => {
    if (!voiceResult) return;
    if (!session) {
      setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
      setVoiceResult(null);
      return;
    }
    setVoiceExecuting(true);
    try {
      await executeVoiceIntent(session.token, voiceResult.transcript, voiceResult.intent);
      setVoiceBanner({ kind: 'success', message: voiceResult.intent.summary });
    } catch (err) {
      setVoiceBanner({ kind: 'error', message: err instanceof ApiError ? err.message : 'Could not execute the voice command.' });
    } finally {
      setVoiceExecuting(false);
      setVoiceResult(null);
    }
  }, [voiceResult, session]);

  const [unread, setUnread] = useState(true);

  // My Shifts is the staff-facing home screen, so it needs a real destination
  // in the shell chrome exactly like /profile has — the four-tab RadialDock is
  // the manager-side nav and has no room for it.
  const onMyShifts = useLocation().pathname === '/my-shifts';

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-20 px-3 pt-3 sm:px-4">
        <div className="glass-bar mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl px-3 py-2.5 shadow-lux sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to="/profile"
              aria-label="Open your profile"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-sm font-bold text-accent transition-transform duration-200 hover:scale-105 active:scale-95"
            >
              {avatarInitial(config.name)}
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
                'grid h-9 w-9 place-items-center rounded-full border transition-all duration-300',
                onMyShifts
                  ? 'glow-gold border-accent/50 bg-accent/15 text-accent'
                  : 'border-border text-foreground/40 hover:text-foreground/70',
              )}
            >
              <CalendarCheck className="h-4 w-4" strokeWidth={onMyShifts ? 2.4 : 1.6} />
            </Link>
            <button
              onClick={() => setUnread((u) => !u)}
              aria-label={unread ? 'Unread notifications' : 'Notifications'}
              className={cn(
                'relative grid h-9 w-9 place-items-center rounded-full border transition-all duration-300',
                unread
                  ? 'glow-gold border-accent/50 bg-accent/15 text-accent'
                  : 'border-border text-foreground/40 hover:text-foreground/70',
              )}
              style={{ transitionTimingFunction: 'cubic-bezier(0.34,1.56,0.64,1)' }}
            >
              <Bell
                className="h-4 w-4"
                strokeWidth={unread ? 2.4 : 1.6}
                fill={unread ? 'currentColor' : 'none'}
                fillOpacity={unread ? 0.22 : 0}
              />
              {unread && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent shadow-glow" />
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        <Outlet />
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

      <VoiceCommandSheet
        intent={voiceResult?.intent ?? null}
        onConfirm={handleVoiceConfirm}
        onCancel={handleVoiceCancel}
        executing={voiceExecuting}
      />

      <RadialDock listening={voiceOn} processing={voiceProcessing} onToggleListening={handleToggleVoice} />
    </div>
  );
}
