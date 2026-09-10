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
  onConfirm,
  onCancel,
  executing,
}: {
  intent: ParsedIntent | null;
  /** What was actually heard. The whole point of confirm-before-execute is catching a mishearing, which is invisible if only the model's paraphrase is shown. */
  transcript: string;
  onConfirm: () => void;
  onCancel: () => void;
  executing: boolean;
}) {
  if (!intent) return null;
  const isUnrecognized = intent.intent === 'UNRECOGNIZED';
  // UNRECOGNIZED's `summary` is typically a generic fallback ("Could not
  // determine what to do."); `reason` is the model's actual explanation of
  // WHY it couldn't resolve the command, and is the only part that teaches
  // the user how to rephrase.
  const reason = isUnrecognized && intent.reason.trim() ? intent.reason : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      // Once execution is in flight the mutation lands regardless — offering a
      // backdrop dismiss here would be a cancel button that cancels nothing.
      onClick={executing ? undefined : onCancel}
    >
      <div className="panel w-full max-w-sm shadow-lux" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <p className="eyebrow">{isUnrecognized ? "Didn't catch that" : 'Confirm voice command'}</p>
          {transcript.trim() && <p className="mt-2 text-xs text-foreground/60">You said: “{transcript.trim()}”</p>}
          <p className="mt-2 text-sm">{intent.summary}</p>
          {reason && <p className="mt-2 text-xs text-foreground/60">{reason}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={onCancel} disabled={executing}>
              Cancel
            </button>
            {!isUnrecognized && (
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
