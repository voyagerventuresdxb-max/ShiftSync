import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pencil, UserPlus } from 'lucide-react';
import type { ParsedIntent } from '@/api/voice';
import { useCloseOnBack } from '@/lib/backNavigation';
import { initials } from '@/lib/feedFormat';
import { cn } from '@/lib/utils';
import { VoicePreview } from '@/components/shiftsync/VoicePreview';

/** Shown once per person on this device, before their first recording: what leaves the phone and what is kept. */
export function VoiceConsentSheet({ open, onAccept, onCancel }: { open: boolean; onAccept: () => void; onCancel: () => void }) {
  useCloseOnBack(open, onCancel);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onCancel}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="voice-consent-title" className="panel w-full max-w-sm shadow-lux" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <p id="voice-consent-title" className="eyebrow">
            Before you use voice
          </p>
          <p className="mt-2 text-sm">
            Your command is recorded on this device (up to 10 seconds) and sent to Google's Gemini AI service, outside the UAE, to turn it into
            text and work out what you asked for.
          </p>
          <p className="mt-2 text-sm text-foreground/60">
            ShiftSync doesn't keep the recording. The text of each command is kept in your venue's voice log, which managers can see, and nothing
            changes until you confirm it.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={onCancel}>
              Not now
            </button>
            <button className="btn btn-primary" onClick={onAccept}>
              Use voice
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** What each kind of command is called on its sheet (the eyebrow), in the app's own words. */
const KIND: Record<string, string> = {
  MARK_AVAILABILITY: 'Your availability',
  REQUEST_SWAP: 'Swap request',
  APPROVE_SWAP: 'Swap request',
  DECLINE_SWAP: 'Swap request',
  APPROVE_JOIN: 'Join request',
  DECLINE_JOIN: 'Join request',
  CREATE_SHIFT: 'New shift',
  EDIT_SHIFT: 'Shift change',
  ASSIGN_SECTION: 'Floor section',
  PUBLISH_ROTA: 'Publish rota',
  APPLY_ROTA_TEMPLATE: 'Rota template',
  POST_ANNOUNCEMENT: 'Announcement',
  POST_SHOUTOUT: 'Shout-out',
};

/** The second line of a person choice: what would happen for them, without repeating their name. */
function choiceDetail(option: ParsedIntent): string {
  return option.intent === 'POST_SHOUTOUT' ? `“${option.content}”` : option.summary;
}

const caption = 'text-[11px] font-medium uppercase tracking-[0.14em] text-foreground/38';

/**
 * Confirm-before-execute sheet for the voice command pipeline: a bottom sheet on phones, a
 * centred card from `sm` up (same overlay conventions as RotaBuilder.tsx's `SheetShell`).
 *
 * One layout for every state: what kind of command it is, one plain sentence, what was heard
 * (editable — "Try again" re-reads the edited words, no new recording), then either a preview of
 * the result exactly as the app will show it, or the choices to pick from. Confirm is the one big
 * button; Edit and Cancel are small. Nothing runs without Confirm.
 */
export function VoiceCommandSheet({
  intent,
  transcript,
  hasAdditionalRequest,
  executed,
  onConfirm,
  onChoose,
  onBackToChoices,
  onReparse,
  onCancel,
  executing,
  reparsing,
  viewerName,
  canManageStaff,
}: {
  intent: ParsedIntent | null;
  /** What was actually heard. The whole point of confirm-before-execute is catching a mishearing, which is invisible if only the model's paraphrase is shown. */
  transcript: string;
  /** Whether the model detected more than one distinct request in the transcript — only ever acted on once the primary intent has reached its own terminal state (see `showFollowUp` below). */
  hasAdditionalRequest: boolean;
  /** True once the primary MUTATING intent has actually executed. Always false for QUERY_MY_SCHEDULE, which has no execute step — its "shown" moment is this component's own render. */
  executed: boolean;
  onConfirm: () => void;
  /** A choice was tapped: the sheet shows that reading for its normal Confirm. Never executes anything itself. */
  onChoose: (option: ParsedIntent) => void;
  /** Set after a choice was picked: back to the list it came from. */
  onBackToChoices?: () => void;
  /** "Try again" with the edited words: a fresh read of the text (no recording). Never executes anything itself. */
  onReparse: (text: string) => void;
  onCancel: () => void;
  executing: boolean;
  reparsing: boolean;
  /** The signed-in person's name, as a post they confirm will show it. */
  viewerName: string;
  /** Managers and owners can add someone who isn't on the team yet (People). */
  canManageStaff: boolean;
}) {
  const busy = executing || reparsing;
  // Back dismisses the sheet exactly like its Cancel/Got it button — but not
  // while something is in flight, for the same reason the backdrop tap is
  // disabled then (a cancel that cancels nothing).
  useCloseOnBack(!!intent, () => {
    if (!busy) onCancel();
  });
  const headingId = useId();
  const heardId = useId();
  // The edit box follows the answer on screen: a new one (a choice, a re-read) starts from what was heard.
  const [shown, setShown] = useState(intent);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(transcript);
  if (intent !== shown) {
    setShown(intent);
    setEditing(false);
    setDraft(transcript);
  }
  if (!intent) return null;

  const isUnrecognized = intent.intent === 'UNRECOGNIZED';
  // QUERY_MY_SCHEDULE is read-only — it never reaches /execute at all (see
  // parseIntent.ts's normalizeParsedIntent and routes/voice.ts's /execute,
  // which deliberately has no case for it), so there is nothing to confirm.
  // `intent.summary` already carries the direct answer for this one intent
  // (see prompts.ts), not a description of a pending action.
  const isAnswerOnly = intent.intent === 'QUERY_MY_SCHEDULE';
  // The additional-request prompt only ever appears once the primary intent
  // has reached ITS OWN terminal state — after a successful execute for a
  // mutating intent (`executed`, set by AppShell only once /execute has
  // succeeded), or immediately for an answer-only intent (which has no
  // execute step at all). An UNRECOGNIZED/low-confidence primary never
  // shows it: compounding a "didn't catch that" message with a "there's
  // more" prompt in the same turn would read as two separate problems, not
  // one (this is also enforced server-side — see interactionLog.ts's
  // shouldPromptForAdditionalRequest — so `hasAdditionalRequest` itself
  // should never even arrive true alongside isUnrecognized, but the check
  // stays here too as defense-in-depth against a stale/hand-crafted prop).
  const showFollowUp = !isUnrecognized && hasAdditionalRequest && (isAnswerOnly || executed);
  // Choices AppShell let through (lib/voiceChoices.ts already dropped any this role can't
  // confirm): a person question keeps even one suggestion, a reading choice needs two.
  const person = isUnrecognized ? (intent.person ?? null) : null;
  const choices = isUnrecognized && intent.options?.length ? intent.options : null;
  const notUnderstood = isUnrecognized && !choices;
  const reason = isUnrecognized && intent.reason.trim() && intent.reason.trim() !== intent.summary.trim() ? intent.reason : null;
  const showEditor = editing || notUnderstood;
  const confirming = !isUnrecognized && !isAnswerOnly && !showFollowUp && !executed;

  // A recognised command missing a part: nearly there, not "didn't catch that".
  const incomplete = isUnrecognized && !!intent.incomplete;
  const eyebrow = incomplete
    ? 'Almost there'
    : person?.status === 'missing'
      ? 'Not on your team'
      : person
        ? 'Which person?'
        : choices
          ? 'Choose one'
          : notUnderstood
            ? "Didn't catch that"
            : showFollowUp
              ? 'Got it — one more thing?'
              : isAnswerOnly
                ? 'Your schedule'
                : (KIND[intent.intent] ?? 'Voice command');
  const headline = executed && !isAnswerOnly ? `Done: ${intent.summary}` : intent.summary;
  const reparse = () => {
    const text = draft.trim();
    if (text && !busy) onReparse(text);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center sm:p-6"
      // Once execution is in flight the mutation lands regardless — offering a
      // backdrop dismiss here would be a cancel button that cancels nothing.
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-busy={busy}
        className="panel max-h-[calc(100dvh-1.5rem-env(safe-area-inset-bottom))] w-full max-w-sm overflow-y-auto overscroll-contain shadow-lux motion-safe:animate-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gold-rule h-px opacity-50" aria-hidden />
        <div className="p-5">
          <div className="flex min-h-6 items-center justify-between gap-3">
            <p className="eyebrow">{eyebrow}</p>
            {onBackToChoices && confirming && (
              <button
                type="button"
                onClick={onBackToChoices}
                disabled={busy}
                className="-my-2.5 -mr-2 inline-flex min-h-11 items-center gap-0.5 rounded-lg px-2 text-xs font-medium text-foreground/60 hover:text-foreground/87 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                Other choices
              </button>
            )}
          </div>
          <h2 id={headingId} className="mt-2 text-[17px] font-semibold leading-snug tracking-tight text-foreground/87">
            {headline}
          </h2>
          {reason && <p className="mt-1.5 text-sm leading-relaxed text-foreground/60">{reason}</p>}

          {person?.status === 'missing' && canManageStaff && (
            <Link
              to="/people"
              onClick={onCancel}
              className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 text-sm font-semibold text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors"
            >
              <UserPlus className="h-4 w-4" aria-hidden />
              Open People
            </Link>
          )}

          {transcript.trim() && (
            <div className="mt-4">
              {showEditor ? (
                <>
                  <label htmlFor={heardId} className={caption}>
                    I heard — fix it and try again
                  </label>
                  <textarea
                    id={heardId}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        reparse();
                      }
                    }}
                    rows={2}
                    maxLength={300}
                    disabled={busy}
                    className="mt-1.5 block min-h-11 w-full resize-none rounded-lg border border-input bg-background/60 p-3 text-sm text-foreground/87 placeholder:text-foreground/38 focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                  />
                </>
              ) : (
                <>
                  <p className={caption}>I heard</p>
                  <p className="mt-1 text-sm leading-relaxed text-foreground/60">“{transcript.trim()}”</p>
                </>
              )}
            </div>
          )}

          {confirming && !showEditor && <VoicePreview intent={intent} viewerName={viewerName} />}

          {choices && !showEditor && (
            <div className="mt-4 flex flex-col gap-2" role="group" aria-label={person ? 'People to choose from' : 'Readings to choose from'}>
              {choices.map((option, i) => {
                const name = person && option.intent !== 'UNRECOGNIZED' ? (option.details?.person ?? null) : null;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onChoose(option)}
                    disabled={busy}
                    className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2.5 text-left hover:border-accent/50 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-safe:transition-colors"
                  >
                    {name && (
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-[11px] font-semibold text-accent" aria-hidden>
                        {initials(name)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground/87">{name ?? option.summary}</span>
                      {name && <span className="mt-0.5 block truncate text-xs text-foreground/60">{choiceDetail(option)}</span>}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-foreground/38" aria-hidden />
                  </button>
                );
              })}
            </div>
          )}

          {showFollowUp && (
            // Reuses global.css's .error-block-toast recipe (border/background/
            // color all var(--accent), via the --color-accent Tailwind token) —
            // this codebase's one existing precedent for "prominent, but
            // neither success nor error", which is exactly what this prompt is.
            <p className="mt-3 rounded-lg border border-accent/40 bg-accent/10 p-2 text-sm text-accent">
              I heard something else in there too — what's the next thing you'd like me to do?
            </p>
          )}

          <div className="mt-5 space-y-2">
            {showEditor ? (
              <>
                <button type="button" className="btn btn-primary h-12 w-full text-base font-semibold" onClick={reparse} disabled={busy || !draft.trim()}>
                  {reparsing ? 'Checking…' : 'Try again'}
                </button>
                <div className={cn('grid gap-2', editing ? 'grid-cols-2' : 'grid-cols-1')}>
                  {editing && (
                    <button type="button" className="btn btn-ghost min-h-11" onClick={() => setEditing(false)} disabled={busy}>
                      Back
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost min-h-11" onClick={onCancel} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </>
            ) : confirming ? (
              <>
                <button type="button" className="btn btn-primary h-12 w-full text-base font-semibold" onClick={onConfirm} disabled={busy}>
                  {executing ? 'Confirming…' : 'Confirm'}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className="btn btn-ghost inline-flex min-h-11 items-center justify-center gap-1.5" onClick={() => setEditing(true)} disabled={busy}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    Edit
                  </button>
                  <button type="button" className="btn btn-ghost min-h-11" onClick={onCancel} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </>
            ) : choices ? (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="btn btn-ghost inline-flex min-h-11 items-center justify-center gap-1.5" onClick={() => setEditing(true)} disabled={busy}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Edit
                </button>
                <button type="button" className="btn btn-ghost min-h-11" onClick={onCancel} disabled={busy}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost min-h-11 w-full" onClick={onCancel} disabled={busy}>
                Got it
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
