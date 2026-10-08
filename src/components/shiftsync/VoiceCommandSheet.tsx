import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronLeft, ChevronRight, Pencil, UserPlus } from 'lucide-react';
import { readingPerson, voiceAnswer, type ParsedIntent, type VoiceAnswer } from '@/api/voice';
import { useCloseOnBack } from '@/lib/backNavigation';
import { initials } from '@/lib/feedFormat';
import { cn } from '@/lib/utils';
import type { VoiceProblem } from '@/lib/voiceErrors';
import type { VoiceOrigin } from '@/lib/voiceSteps';
import { confirmLabel, isAppPath } from '@/lib/voiceWording';
import { VoicePreview } from '@/components/shiftsync/VoicePreview';
import { VoiceProgress } from '@/components/shiftsync/VoiceProgress';
import { ExamplePhrases } from '@/components/shiftsync/VoiceComposer';
import { repeatsSentence } from '../../../shared/voiceIntents';

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
  CANCEL_SHIFT: 'Cancel shift',
  REQUEST_TIME_OFF: 'Time off',
};

/** The eyebrow over each kind of answer. */
const ANSWER_KIND: Record<string, string> = {
  QUERY_MY_SCHEDULE: 'Your schedule',
  WHO_IS_WORKING: "Who's working",
  WHO_IN_SECTION: 'Sections',
  PENDING_REQUESTS: 'Requests',
  RECENT_ANNOUNCEMENTS: 'Announcements',
};

/** The second line of a person choice: what would happen for them, without repeating their name. */
function choiceDetail(option: ParsedIntent): string {
  return option.intent === 'POST_SHOUTOUT' ? `“${option.content}”` : option.summary;
}

const caption = 'text-[11px] font-medium uppercase tracking-[0.14em] text-foreground/60';

/** The big gold Confirm (and Update preview): the one action that does something. Utilities, not .btn, so its size and radius hold. */
const primaryAction =
  'inline-flex h-14 w-full items-center justify-center rounded-2xl bg-accent text-[17px] font-semibold text-accent-foreground hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 motion-safe:transition';
/** Edit, Cancel, Back, Done: quiet, smaller, still 48 px tall. */
const quietAction =
  'inline-flex min-h-12 items-center justify-center gap-1.5 rounded-2xl border border-border px-4 text-sm font-medium text-foreground/60 hover:border-foreground/30 hover:text-foreground/87 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-safe:transition-colors';
/** Editing a preview: the action that applies is gold, the other is quiet (and disabled). */
const editAction =
  'inline-flex h-12 w-full items-center justify-center rounded-2xl bg-accent px-4 text-base font-semibold text-accent-foreground hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 motion-safe:transition';
const quietEditAction =
  'inline-flex h-12 w-full items-center justify-center rounded-2xl border border-border px-4 text-base font-medium text-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-safe:transition';
/** A tappable card: a person, a reading, a name to try. */
const choiceCard =
  'flex min-h-16 w-full items-center gap-3.5 rounded-2xl border border-border bg-background/50 px-3.5 py-3 text-left hover:border-accent/50 hover:bg-accent/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-safe:transition-colors';
const initialsDisc = 'grid h-10 w-10 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-xs font-semibold text-accent';

/**
 * Confirm-before-execute sheet for the voice command pipeline: it rises from the bottom of the
 * voice sheet (VoiceStage), whose orb stays above it as a small ring.
 *
 * One layout for every state: what kind of command it is, one plain sentence, what was heard
 * (tap the words or Edit — "Update preview" re-reads the edited words, no new recording), then either a preview of
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
  origin = 'voice',
  examples = [],
  problem = null,
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
  /** "Update preview" with the edited words: a fresh read of the text (no recording). Never executes anything itself. */
  onReparse: (text: string) => void;
  onCancel: () => void;
  executing: boolean;
  reparsing: boolean;
  /** The signed-in person's name, as a post they confirm will show it. */
  viewerName: string;
  /** Managers and owners can add someone who isn't on the team yet (People). */
  canManageStaff: boolean;
  /** Spoken ("I heard") or typed ("You typed"): how the command started. */
  origin?: VoiceOrigin;
  /** Phrases this person's role can use, offered when a command wasn't understood. Tapping one fills the box. */
  examples?: string[];
  /** Why the last Confirm didn't go through (offline, timeout): shown above the buttons, so Confirm can be tapped again. */
  problem?: VoiceProblem | null;
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
  const heardRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Each new reading or answer: focus moves onto the sheet, so a screen reader starts from its heading.
  useEffect(() => {
    if (intent) panelRef.current?.focus({ preventScroll: true });
  }, [intent]);
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
  // Reads never reach /execute (the server answers 400 for them), so there is
  // nothing to confirm: the server's `answer` is the whole result. An older
  // server's QUERY_MY_SCHEDULE has no `answer` and carries it in `summary`.
  const answer = voiceAnswer(intent);
  const isAnswerOnly = intent.intent === 'QUERY_MY_SCHEDULE' || !!answer;
  // Something never done by voice: the server's message and, when there is one, the screen for it.
  const declined = intent.intent === 'DECLINED' ? intent : null;
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
  // Never the same sentence twice (the server already avoids it; this is the second check).
  const reason = isUnrecognized && intent.reason.trim() && !repeatsSentence(intent.reason, intent.summary) ? intent.reason : null;
  const retry = isUnrecognized && !choices ? (intent.retry ?? []) : [];
  const team = isUnrecognized && !choices ? (intent.team ?? []) : [];
  const showEditor = editing || notUnderstood;
  const confirming = !isUnrecognized && !isAnswerOnly && !declined && !showFollowUp && !executed;
  // The same states that offer Edit.
  const canEdit = (confirming || !!choices) && !busy;
  // The preview on screen was made from `transcript`. Once the edited words differ, it is out of
  // date: it stays visible but dimmed, and Confirm is disabled until Update preview has read the
  // new words (or the words are put back exactly). Confirm only ever sends the previewed reading.
  const stale = confirming && editing && draft.trim() !== transcript.trim();
  const confirm = () => {
    if (!stale && !busy) onConfirm();
  };

  // A recognised command missing a part: nearly there, not "didn't catch that".
  const incomplete = isUnrecognized && !!intent.incomplete;
  // Plainly not understood (not a missing part, not a name question): phrases that do work.
  const showExamples = notUnderstood && !incomplete && !person && examples.length > 0;
  const typed = origin === 'typed';
  const eyebrow = declined
    ? 'Not by voice'
    : incomplete
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
                  ? (ANSWER_KIND[intent.intent] ?? 'Answer')
                  : (KIND[intent.intent] ?? 'Voice command');
  const headline = declined ? declined.message : answer ? answer.title : executed && !isAnswerOnly ? `Done: ${intent.summary}` : intent.summary;
  const screen = declined?.screen && isAppPath(declined.screen.path) ? declined.screen : null;
  const reparse = () => {
    const text = draft.trim();
    if (text && !busy) onReparse(text);
  };

  return (
    <div
      // Rises from the bottom of the voice sheet (VoiceStage), which stays behind it with the orb;
      // it fills the sheet's box, so it too stays above an on-screen keyboard.
      className="absolute inset-0 z-50 flex items-end justify-center"
      // Once execution is in flight the mutation lands regardless — offering a
      // backdrop dismiss here would be a cancel button that cancels nothing.
      onClick={busy ? undefined : onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-busy={busy}
        tabIndex={-1}
        // Its height is a share of the voice sheet's visible box (above an on-screen keyboard); on a
        // short screen it takes nearly all of it. Only the body scrolls: the buttons stay pinned.
        className="panel flex max-h-[calc(100%-9rem)] w-full max-w-md flex-col overflow-hidden rounded-b-none border-b-0 shadow-lux focus:outline-none group-data-[short=true]/stage:max-h-[calc(100%-3.5rem)] motion-safe:animate-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gold-rule h-px shrink-0 opacity-40" aria-hidden />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-6" data-voice-scroll>
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
          <h2 id={headingId} className="mt-2 text-[19px] font-semibold leading-snug tracking-tight text-foreground/87">
            {headline}
          </h2>
          {reason && <p className="mt-1.5 text-sm leading-relaxed text-foreground/60">{reason}</p>}

          {retry.length > 0 && (
            <div className="mt-4 flex flex-col gap-2" role="group" aria-label="Names to try instead">
              {retry.map((r) => (
                <button
                  key={r.person}
                  type="button"
                  onClick={() => onReparse(r.text)}
                  disabled={busy}
                  className={choiceCard}
                >
                  <span className={initialsDisc} aria-hidden>
                    {initials(r.person)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-foreground/87">{r.person}</span>
                    <span className="mt-0.5 block truncate text-xs text-foreground/60">Update the preview with this name</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-foreground/60" aria-hidden />
                </button>
              ))}
            </div>
          )}

          {screen && (
            <Link
              to={screen.path}
              onClick={onCancel}
              className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 text-sm font-semibold text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors"
            >
              Open {screen.label}
              <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
          )}

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
                    {typed ? 'You typed' : 'I heard'} — fix it, then update the preview
                  </label>
                  <textarea
                    ref={heardRef}
                    id={heardId}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        reparse();
                      }
                    }}
                    rows={confirming ? 2 : 3}
                    maxLength={300}
                    disabled={busy}
                    className="mt-2 block min-h-11 w-full resize-none rounded-2xl border border-input bg-background/50 px-4 py-3 text-[17px] leading-relaxed text-foreground/87 placeholder:text-foreground/50 focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                  />
                  {showExamples && (
                    <ExamplePhrases
                      examples={examples}
                      disabled={busy}
                      onPick={(phrase) => {
                        setDraft(phrase);
                        heardRef.current?.focus();
                      }}
                    />
                  )}
                </>
              ) : (
                <div
                  // Tapping the words is a shortcut to Edit (the Edit button below is the keyboard way).
                  onClick={canEdit ? () => setEditing(true) : undefined}
                  className={cn(canEdit && '-mx-2 cursor-text rounded-2xl px-2 py-1.5 hover:bg-foreground/[0.03]')}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className={caption}>{typed ? 'You typed' : 'I heard'}</p>
                    {canEdit && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-foreground/60" aria-hidden>
                        <Pencil className="h-3 w-3" />
                        Tap to edit
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 font-['Instrument_Serif',ui-serif,Georgia,serif] text-[22px] leading-snug text-foreground/87">“{transcript.trim()}”</p>
                </div>
              )}
            </div>
          )}

          {answer && <AnswerList answer={answer} />}

          {team.length > 0 && <TeamPicker heard={person?.heard ?? ''} team={team} onChoose={onChoose} busy={busy} />}

          {confirming && (
            <div className="relative">
              {stale && (
                <p className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-warning">
                  Out of date
                </p>
              )}
              <div className={cn('motion-safe:transition-opacity motion-safe:duration-200', stale && 'opacity-40 saturate-50')} data-preview-stale={stale || undefined}>
                <VoicePreview intent={intent} viewerName={viewerName} />
              </div>
            </div>
          )}

          {choices && !showEditor && (
            <div className="mt-4 flex flex-col gap-2" role="group" aria-label={person ? 'People to choose from' : 'Readings to choose from'}>
              {choices.map((option, i) => {
                const who = person ? readingPerson(option) : null;
                const name = who?.name ?? null;
                const role = who?.role ?? null;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onChoose(option)}
                    disabled={busy}
                    className={choiceCard}
                  >
                    {name && (
                      <span className={initialsDisc} aria-hidden>
                        {initials(name)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-foreground/87">
                        {name ?? option.summary}
                        {role && <span className="font-normal text-foreground/60"> · {role}</span>}
                      </span>
                      {name && <span className="mt-0.5 block truncate text-xs text-foreground/60">{choiceDetail(option)}</span>}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-foreground/60" aria-hidden />
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

          {(confirming || isAnswerOnly) && !showFollowUp && (
            <VoiceProgress
              className="mt-5"
              origin={origin}
              kind={isAnswerOnly ? 'read' : 'change'}
              step={isAnswerOnly ? 'answered' : executing ? 'doing' : 'ready'}
              label={stale ? 'Editing: tap Update preview' : undefined}
              announce={stale ? 'Editing, preview out of date' : undefined}
              warning={stale}
            />
          )}

          {problem && confirming && (
            <div role="alert" className="mt-4 rounded-2xl border border-warning/35 bg-warning/10 p-3.5">
              <p className="text-sm font-semibold text-foreground/87">{problem.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-foreground/60">{problem.message}</p>
            </div>
          )}

        </div>
        <div className="shrink-0 space-y-2 border-t border-border/70 bg-surface px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3" data-voice-actions>
            {confirming && editing ? (
              <>
                {/* Editing a preview: Update preview reads the new words; Confirm stays the previewed
                    reading and is disabled while the words on screen differ from it. */}
                <button type="button" className={stale || reparsing ? editAction : quietEditAction} onClick={reparse} disabled={busy || !stale}>
                  {reparsing ? 'Checking…' : 'Update preview'}
                </button>
                <button type="button" className={stale ? quietEditAction : editAction} onClick={confirm} disabled={busy || stale}>
                  {executing ? 'Confirming…' : confirmLabel(intent)}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={quietAction}
                    onClick={() => {
                      setEditing(false);
                      setDraft(transcript);
                    }}
                    disabled={busy}
                  >
                    Back
                  </button>
                  <button type="button" className={quietAction} onClick={onCancel} disabled={busy}>
                    {intent.intent === 'CANCEL_SHIFT' ? 'Keep shift' : 'Cancel'}
                  </button>
                </div>
              </>
            ) : showEditor ? (
              <>
                <button type="button" className={primaryAction} onClick={reparse} disabled={busy || !draft.trim()}>
                  {reparsing ? 'Checking…' : 'Update preview'}
                </button>
                <div className={cn('grid gap-2', editing ? 'grid-cols-2' : 'grid-cols-1')}>
                  {editing && (
                    <button type="button" className={quietAction} onClick={() => setEditing(false)} disabled={busy}>
                      Back
                    </button>
                  )}
                  <button type="button" className={quietAction} onClick={onCancel} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </>
            ) : confirming ? (
              <>
                <button type="button" className={primaryAction} onClick={confirm} disabled={busy}>
                  {executing ? 'Confirming…' : confirmLabel(intent)}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className={quietAction} onClick={() => setEditing(true)} disabled={busy}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    Edit
                  </button>
                  {/* "Cancel" beside "cancel this shift" would read as the same thing: this one keeps it. */}
                  <button type="button" className={quietAction} onClick={onCancel} disabled={busy}>
                    {intent.intent === 'CANCEL_SHIFT' ? 'Keep shift' : 'Cancel'}
                  </button>
                </div>
              </>
            ) : choices ? (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className={quietAction} onClick={() => setEditing(true)} disabled={busy}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Edit
                </button>
                <button type="button" className={quietAction} onClick={onCancel} disabled={busy}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className={cn(quietAction, 'w-full')} onClick={onCancel} disabled={busy}>
                {answer ? 'Done' : 'Got it'}
              </button>
            )}
        </div>
      </div>
    </div>
  );
}

/**
 * "I heard Rana — pick from your team": nobody at the venue sounds like the name said, so the
 * whole team is listed (name and role), with a search box. Picking someone opens that reading's
 * normal confirm sheet; nothing runs without Confirm, and nobody is ever created from here.
 */
/** A read's answer: one row per item (primary, then secondary and tertiary lines), or the server's empty text. Text only, never HTML. */
function AnswerList({ answer }: { answer: VoiceAnswer }) {
  if (!answer.items.length) return <p className="mt-4 text-sm leading-relaxed text-foreground/60">{answer.emptyText}</p>;
  return (
    <ul className="mt-4 flex flex-col gap-2" aria-label={answer.title}>
      {answer.items.map((item, i) => (
        <li key={i} className="rounded-2xl border border-border bg-background/50 px-3.5 py-3">
          <p className="text-[15px] font-semibold text-foreground/87">{item.primary}</p>
          {item.secondary && <p className="mt-0.5 text-xs font-medium text-accent">{item.secondary}</p>}
          {item.tertiary && <p className="mt-0.5 text-xs text-foreground/60">{item.tertiary}</p>}
        </li>
      ))}
    </ul>
  );
}

function TeamPicker({ heard, team, onChoose, busy }: { heard: string; team: ParsedIntent[]; onChoose: (option: ParsedIntent) => void; busy: boolean }) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const people = team.flatMap((option) => {
    const who = readingPerson(option);
    return who ? [{ option, name: who.name, role: who.role }] : [];
  });
  const q = query.trim().toLowerCase();
  const shown = q ? people.filter((p) => p.name.toLowerCase().includes(q) || (p.role ?? '').toLowerCase().includes(q)) : people;
  return (
    <div className="mt-4">
      <p id={searchId} className={caption}>
        {heard ? `I heard “${heard}” — pick from your team` : 'Pick from your team'}
      </p>
      <input
        aria-label="Search your team"
        aria-describedby={searchId}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your team"
        disabled={busy}
        className="mt-2 block min-h-12 w-full rounded-2xl border border-input bg-background/50 px-4 text-[17px] text-foreground/87 placeholder:text-foreground/50 focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
      <div className="mt-2 flex max-h-64 flex-col gap-2 overflow-y-auto overscroll-contain" role="group" aria-label="Your team">
        {shown.map(({ option, name, role }) => (
          <button
            key={name + (role ?? '')}
            type="button"
            onClick={() => onChoose(option)}
            disabled={busy}
            className={cn(choiceCard, 'shrink-0')}
          >
            <span className={initialsDisc} aria-hidden>
              {initials(name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold text-foreground/87">{name}</span>
              {role && <span className="mt-0.5 block truncate text-xs text-foreground/60">{role}</span>}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-foreground/60" aria-hidden />
          </button>
        ))}
        {!shown.length && <p className="py-2 text-sm text-foreground/60">Nobody on your team matches “{query.trim()}”.</p>}
      </div>
    </div>
  );
}
