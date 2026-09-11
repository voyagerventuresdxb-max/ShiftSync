import type { ParsedIntent } from '@/api/voice';

/**
 * Confirm-before-execute sheet for the voice command pipeline. Mirrors the
 * overlay conventions already used by RotaBuilder.tsx's `SheetShell` and
 * ScheduleEditorRoute.tsx's confirm dialog (fixed inset-0, bg-background/70
 * + backdrop-blur-sm, a `panel` card) rather than inventing a new modal
 * style for this one feature.
 */
export function VoiceCommandSheet({
  intent,
  transcript,
  hasAdditionalRequest,
  executed,
  onConfirm,
  onCancel,
  executing,
}: {
  intent: ParsedIntent | null;
  /** What was actually heard. The whole point of confirm-before-execute is catching a mishearing, which is invisible if only the model's paraphrase is shown. */
  transcript: string;
  /** Whether the model detected more than one distinct request in the transcript — only ever acted on once the primary intent has reached its own terminal state (see `showFollowUp` below). */
  hasAdditionalRequest: boolean;
  /** True once the primary MUTATING intent has actually executed. Always false for QUERY_MY_SCHEDULE, which has no execute step — its "shown" moment is this component's own render. */
  executed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  executing: boolean;
}) {
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
  // UNRECOGNIZED's `summary` is typically a generic fallback ("Could not
  // determine what to do."); `reason` is the model's actual explanation of
  // WHY it couldn't resolve the command, and is the only part that teaches
  // the user how to rephrase.
  const reason = isUnrecognized && intent.reason.trim() ? intent.reason : null;

  const eyebrow = isUnrecognized
    ? "Didn't catch that"
    : showFollowUp
      ? 'Got it — one more thing?'
      : isAnswerOnly
        ? 'Your schedule'
        : 'Confirm voice command';
  const dismissLabel = showFollowUp || isAnswerOnly ? 'Got it' : 'Cancel';
  const showConfirmButton = !isUnrecognized && !isAnswerOnly && !showFollowUp;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      // Once execution is in flight the mutation lands regardless — offering a
      // backdrop dismiss here would be a cancel button that cancels nothing.
      onClick={executing ? undefined : onCancel}
    >
      <div className="panel w-full max-w-sm shadow-lux" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <p className="eyebrow">{eyebrow}</p>
          {transcript.trim() && <p className="mt-2 text-xs text-foreground/60">You said: “{transcript.trim()}”</p>}
          <p className="mt-2 text-sm">{executed && !isAnswerOnly ? `Done: ${intent.summary}` : intent.summary}</p>
          {reason && <p className="mt-2 text-xs text-foreground/60">{reason}</p>}
          {showFollowUp && (
            // Reuses global.css's .error-block-toast recipe (border/background/
            // color all var(--accent), via the --color-accent Tailwind token) —
            // this codebase's one existing precedent for "prominent, but
            // neither success nor error", which is exactly what this prompt is.
            <p className="mt-3 rounded-lg border border-accent/40 bg-accent/10 p-2 text-sm text-accent">
              I heard something else in there too — what's the next thing you'd like me to do?
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={onCancel} disabled={executing}>
              {dismissLabel}
            </button>
            {showConfirmButton && (
              <button className="btn btn-primary" onClick={onConfirm} disabled={executing}>
                {executing ? 'Executing…' : 'Confirm'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
