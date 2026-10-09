import { Component, Fragment, Suspense, lazy, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { ChevronDown, Keyboard, LoaderCircle, Mic, Square } from 'lucide-react';
import { VoiceComposer } from '@/components/shiftsync/VoiceComposer';
import { loadVoiceOrb } from '@/components/shiftsync/voiceOrbChunk';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useVisibleViewport } from '@/hooks/useVisibleViewport';
import { useCloseOnBack } from '@/lib/backNavigation';
import { cn } from '@/lib/utils';
import { ORB_PERSONALITIES, orbLook, type OrbVariant } from '@/lib/voiceOrb';
import {
  voiceCloseAction,
  voiceMicControl,
  voiceOrbPhase,
  voiceStageAnnouncement,
  voiceStageMode,
  voiceStagePosition,
  voiceStageWord,
  type VoiceCloseAction,
  type VoiceStageMode,
  type VoiceStageState,
} from '@/lib/voiceStage';

/**
 * The orb and its library load only when the voice sheet first opens (and the dock's mic warms
 * them on touch). The sheet itself is not lazy: it is what opens when the phone is offline, when
 * a lazy chunk could not be fetched — then the sheet simply has no orb.
 */
const VoiceOrb = lazy(() => loadVoiceOrb().then((m) => ({ default: m.VoiceOrb })));

/** A failed orb download leaves an empty space, never a broken sheet. */
class OrbBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** How long one recording may run (AppShell's MAX_RECORDING_MS): the ring around the mic counts it down. */
const RECORDING_MS = 10_000;

/**
 * The orb gives way first when the visible height is short (a small phone, or the keyboard up):
 * the bottom row is pinned and the middle scrolls, so nothing pushes the buttons off screen.
 */
function orbSizeFor(visibleHeight: number, b: boolean): number {
  if (b) return visibleHeight < 560 ? 64 : 104;
  return visibleHeight >= 760 ? 184 : visibleHeight >= 640 ? 144 : visibleHeight >= 520 ? 112 : 72;
}

/**
 * "Heard" text appearing word by word once the transcript arrives (there are no live captions:
 * nothing shows while the person is still speaking). Under 400 ms in total; at once with reduced
 * motion. The words stay one text, so it reads (and is found) as the sentence it is.
 */
function RevealText({ text, animate }: { text: string; animate: boolean }) {
  const words = text.trim().split(/\s+/);
  // The last word starts by 230 ms and takes 160 ms: under 400 ms however long the sentence.
  const step = words.length > 1 ? Math.min(40, 230 / (words.length - 1)) : 0;
  return (
    <>
      {words.map((word, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={animate ? 'voice-word' : undefined} style={animate ? { animationDelay: `${Math.round(i * step)}ms` } : undefined}>
            {word}
          </span>
        </Fragment>
      ))}
    </>
  );
}

const iconButton =
  'grid h-12 w-12 place-items-center rounded-full border border-border bg-surface text-foreground/60 hover:text-foreground/87 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 motion-safe:transition-colors';

function MicButton({ mode, onMic, size, micRef }: { mode: VoiceStageMode; onMic: () => void; size: number; micRef: RefObject<HTMLButtonElement | null> }) {
  const { action, label } = voiceMicControl(mode);
  const recording = mode === 'listening';
  const busy = action === 'none';
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <button
      ref={micRef}
      type="button"
      onClick={busy ? undefined : onMic}
      disabled={busy}
      aria-label={label}
      aria-pressed={recording}
      className={cn(
        'relative grid shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-safe:transition-colors motion-safe:duration-300',
        recording ? 'bg-accent text-accent-foreground' : 'border border-accent/45 bg-accent/10 text-accent hover:bg-accent/15',
        busy && 'cursor-wait opacity-80',
      )}
      style={{ width: size, height: size }}
    >
      {recording && (
        // The 10-second limit, counting down: the recording stops (and is sent) when the ring is gone.
        <svg className="pointer-events-none absolute inset-0 -rotate-90" viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={2} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={c}
            className="voice-countdown"
            style={{ ['--voice-ring' as string]: `${c}px`, animationDuration: `${RECORDING_MS}ms` }}
          />
        </svg>
      )}
      {busy ? (
        <LoaderCircle className="h-6 w-6 motion-safe:animate-spin" aria-hidden />
      ) : recording ? (
        <Square className="h-5 w-5" fill="currentColor" aria-hidden />
      ) : (
        <Mic className="h-7 w-7" aria-hidden />
      )}
    </button>
  );
}

/**
 * The voice sheet: full height, near-black, the orb in the middle. Top: close and whose venue,
 * in which role. Middle: the orb, one word for the step, then what was heard (or the typed
 * box, with the problem when there is one). Bottom, pinned: the microphone with the keyboard on
 * one side and Cancel on the other — or, for a typed command, Show preview between the mic and
 * Cancel. The sheet fills only the visible part of the screen (above an on-screen keyboard) and
 * only its middle scrolls. The confirm sheet (`children`) rises over the lower part, and the
 * orb above it shrinks to a small ring.
 *
 * Nothing here decides anything: every step and button maps to what AppShell already does
 * (lib/voiceStage.ts). Two compositions: `a` (recommended, centred and quiet) and `b` (the
 * alternative in the dev preview: left-aligned, the words larger, controls in one capsule).
 */
export function VoiceStage({
  state,
  variant = 'a',
  context,
  heard,
  level,
  composerText,
  examples,
  onComposerChange,
  onSend,
  onMic,
  onClose,
  children,
}: {
  state: VoiceStageState;
  variant?: OrbVariant;
  /** "Venue · Role". */
  context: string;
  /** What the recording said, once transcribed (empty before). */
  heard: string;
  /** The live microphone level while recording (lib/audioLevel.ts). */
  level?: RefObject<number | null>;
  composerText: string;
  examples: string[];
  onComposerChange: (text: string) => void;
  onSend: (text: string) => void;
  /** Start or stop recording (the same as the dock's mic). */
  onMic: () => void;
  onClose: (action: VoiceCloseAction) => void;
  /** The confirm sheet, when there is a reading or an answer. */
  children?: ReactNode;
}) {
  const mode = voiceStageMode(state);
  const reduced = useReducedMotion();
  const visible = useVisibleViewport();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const hasSheet = mode === 'result';
  const composerShown = mode === 'typing' || mode === 'problem' || mode === 'sending-typed';
  const closeAction = voiceCloseAction(mode);
  const close = () => {
    if (closeAction !== 'none') onClose(closeAction);
  };
  // Back (browser or Android) does what the close button does; the confirm sheet has its own.
  useCloseOnBack(!hasSheet, close);

  const look = orbLook(voiceOrbPhase(state), reduced);
  const word = voiceStageWord(state);
  const announcement = voiceStageAnnouncement(state);
  const position = voiceStagePosition(state, mode === 'sending-typed' ? 'typed' : 'voice');
  const b = variant === 'b';
  const orbSize = orbSizeFor(visible.height, b);
  // The orb gives way to the typed box and to the confirm sheet.
  const scale = b ? (hasSheet ? 0.7 : 1) : look.scale * (mode === 'problem' ? 0.45 : composerShown ? 0.6 : 1);
  // Starting, listening and reading: the orb, its word and what was heard sit together in the middle.
  const voiceStep = mode === 'starting' || mode === 'listening' || mode === 'transcribing' || mode === 'understanding';

  // Focus follows the step: the mic while recording, the sheet itself when there is something to read.
  useEffect(() => {
    if (mode === 'listening') micRef.current?.focus({ preventScroll: true });
    else if (mode === 'problem' || mode === 'starting' || mode === 'transcribing' || mode === 'understanding') panelRef.current?.focus({ preventScroll: true });
  }, [mode]);

  const keyboard = (
    <button
      type="button"
      onClick={() => panelRef.current?.querySelector('textarea')?.focus()}
      disabled={!composerShown || mode === 'sending-typed'}
      aria-label="Type instead"
      aria-pressed={composerShown}
      className={cn(iconButton, composerShown && 'border-accent/40 text-accent')}
    >
      <Keyboard className="h-5 w-5" aria-hidden />
    </button>
  );
  const cancel = (
    <button
      type="button"
      onClick={close}
      disabled={closeAction === 'none'}
      className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-full px-4 text-sm font-medium text-foreground/60 hover:text-foreground/87 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
    >
      Cancel
    </button>
  );
  // The typed box has its own heading; then the word is only a label.
  const Word = composerShown ? 'p' : 'h2';
  const mic = <MicButton mode={mode} onMic={onMic} size={b ? 60 : 76} micRef={micRef} />;
  const sending = state.composer.sending;
  const send = () => {
    const text = composerText.trim();
    if (text && !sending) onSend(text);
  };
  // Typed: the mic moves to the side (to switch back to voice) and Show preview takes the middle.
  const micSide = (
    <button
      type="button"
      onClick={voiceMicControl(mode).action === 'none' ? undefined : onMic}
      disabled={voiceMicControl(mode).action === 'none'}
      aria-label={voiceMicControl(mode).label}
      className={cn(iconButton, 'border-accent/40 text-accent')}
    >
      <Mic className="h-5 w-5" aria-hidden />
    </button>
  );
  const showPreview = (
    <button
      type="button"
      onClick={send}
      disabled={sending || !composerText.trim()}
      className="inline-flex h-14 min-w-0 flex-1 items-center justify-center rounded-2xl bg-accent px-4 text-base font-semibold text-accent-foreground hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 motion-safe:transition"
    >
      {sending ? 'Checking…' : 'Show preview'}
    </button>
  );

  return (
    <div
      className="voice-stage fixed inset-x-0 z-50 overflow-hidden bg-background text-foreground"
      // The visible part of the screen: above an on-screen keyboard, the whole screen otherwise.
      style={visible.height ? { top: visible.top, height: visible.height } : { top: 0, bottom: 0 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !hasSheet) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-hidden={hasSheet || undefined}
        inert={hasSheet}
        tabIndex={-1}
        className="mx-auto flex h-full max-w-md flex-col px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))] focus:outline-none"
      >
        <div className="flex h-12 shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={close}
            disabled={closeAction === 'none'}
            aria-label="Close"
            className={cn(
              '-ml-2 grid h-11 w-11 place-items-center rounded-full text-foreground/60 hover:text-foreground/87 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
              // Under the confirm sheet the sheet has the way out (its Cancel).
              hasSheet && 'invisible',
            )}
          >
            <ChevronDown className="h-5 w-5" aria-hidden />
          </button>
          <p className={cn('min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/60', b ? 'text-left' : 'text-center')}>{context}</p>
          {!b && <span className="w-11 shrink-0" aria-hidden />}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-voice-scroll>
        <div className={cn('flex min-h-full flex-col', voiceStep && !b && 'justify-center pb-4')}>
          <div className={cn('flex shrink-0', b ? 'mt-4 items-center gap-4' : 'mt-2 flex-col items-center')}>
            <div
              className="shrink-0 motion-safe:transition-[height,width] motion-safe:duration-500 motion-safe:ease-out"
              style={{ height: orbSize * scale, width: b ? orbSize * scale : undefined }}
            >
              <div className="motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out" style={{ transform: `scale(${scale})`, transformOrigin: b ? 'top left' : 'top center' }}>
                <OrbBoundary>
                  <Suspense fallback={<div style={{ width: orbSize, height: orbSize }} />}>
                    <VoiceOrb look={look} size={orbSize} personality={ORB_PERSONALITIES[variant]} level={level} reducedMotion={reduced} />
                  </Suspense>
                </OrbBoundary>
              </div>
            </div>
            {(word || !composerShown) && (
              <div className={cn('flex flex-col', b ? 'items-start' : composerShown ? 'mt-2 items-center' : 'mt-4 items-center')}>
                {/* One word for the step (the live region below says it in full). */}
                <Word id={composerShown ? undefined : headingId} className="min-h-5 text-[12px] font-semibold uppercase tracking-[0.32em] text-accent">
                  {word || <span className="sr-only">Voice command</span>}
                </Word>
                {position && (
                  <div className="mt-2.5 flex gap-1.5" aria-hidden>
                    {Array.from({ length: position.total }, (_, i) => (
                      <span key={i} className={cn('h-1 w-5 rounded-full motion-safe:transition-colors motion-safe:duration-300', i < position.index ? 'bg-accent/80' : 'bg-foreground/15')} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {!hasSheet && (
            <p role="status" aria-live="polite" className="sr-only">
              {announcement}
            </p>
          )}

          {voiceStep && (
            // Room kept for the words before they arrive, so nothing jumps when they do.
            <div className={cn('min-h-[8.5rem]', b ? 'mt-8 text-left' : 'mt-9 text-center')}>
              {heard && (
                <>
                  <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/60">I heard</p>
                  <p className={cn("mt-3 font-['Instrument_Serif',ui-serif,Georgia,serif] leading-[1.25] text-foreground/87", b ? 'text-[32px]' : 'text-[27px]')}>
                    “<RevealText text={heard} animate={!reduced} />”
                  </p>
                </>
              )}
            </div>
          )}
          {composerShown && (
            <div className="mt-5 pb-2">
              <VoiceComposer
                value={composerText}
                onChange={onComposerChange}
                problem={state.composer.problem}
                sending={state.composer.sending}
                examples={examples}
                onSend={onSend}
                headingId={headingId}
              />
            </div>
          )}
        </div>
        </div>

        {/* Pinned: never scrolls away, never pushed off by the orb or a problem message. */}
        <div className={cn('shrink-0', hasSheet && 'hidden')} data-voice-actions>
          {composerShown ? (
            <div className={cn('flex items-center gap-3 pt-3', b && 'glass-bar rounded-full p-1.5')}>
              {micSide}
              {showPreview}
              {cancel}
            </div>
          ) : b ? (
            <div className="glass-bar grid grid-cols-[1fr_auto_1fr] items-center rounded-full p-1.5">
              <div className="justify-self-start">{keyboard}</div>
              {mic}
              <div className="justify-self-end">{cancel}</div>
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_auto_1fr] items-center pt-4">
              <div className="justify-self-start">{keyboard}</div>
              {mic}
              <div className="justify-self-end">{cancel}</div>
            </div>
          )}
          {!composerShown && (
            <p className="mt-2 h-4 text-center text-[12px] text-foreground/60" aria-hidden>
              {mode === 'listening' ? 'Tap to stop' : ''}
            </p>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

export default VoiceStage;
