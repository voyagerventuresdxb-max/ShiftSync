import { useId, useRef } from 'react';
import { Send } from 'lucide-react';
import { useCloseOnBack } from '@/lib/backNavigation';
import type { VoiceProblem } from '@/lib/voiceErrors';
import { VoiceProgress } from '@/components/shiftsync/VoiceProgress';

const caption = 'text-[11px] font-medium uppercase tracking-[0.14em] text-foreground/38';

/** Phrases to try, as tappable chips. Tapping one only fills the box; nothing is sent until the person sends it. */
export function ExamplePhrases({ examples, onPick, disabled }: { examples: string[]; onPick: (phrase: string) => void; disabled?: boolean }) {
  if (!examples.length) return null;
  return (
    <div className="mt-3">
      <p className={caption}>Or try</p>
      <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Examples to try">
        {examples.map((phrase) => (
          <button
            key={phrase}
            type="button"
            onClick={() => onPick(phrase)}
            disabled={disabled}
            className="inline-flex min-h-11 items-center rounded-full border border-border bg-background/40 px-3.5 py-2 text-left text-[13px] text-foreground/60 hover:border-accent/50 hover:bg-accent/5 hover:text-foreground/87 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-safe:transition-colors"
          >
            {phrase}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The typed command box: opened from the keyboard button next to the mic, and on every voice
 * problem (microphone off, offline, timeout, assistant unavailable, limit reached), which it shows
 * above the box in plain words. What is typed goes through the same reading, preview and Confirm
 * as a spoken command.
 */
export function VoiceComposer({
  open,
  value,
  onChange,
  problem,
  sending,
  examples,
  onSend,
  onCancel,
}: {
  open: boolean;
  value: string;
  onChange: (text: string) => void;
  /** Why the box opened instead of (or after) the voice flow; null when opened to type. */
  problem: VoiceProblem | null;
  /** The typed command is being read (parse-intent in flight). */
  sending: boolean;
  examples: string[];
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  useCloseOnBack(open, () => {
    if (!sending) onCancel();
  });
  const headingId = useId();
  const inputId = useId();
  const problemId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  if (!open) return null;
  const send = () => {
    const text = value.trim();
    if (text && !sending) onSend(text);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center sm:p-6"
      onClick={sending ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={problem ? problemId : undefined}
        aria-busy={sending}
        className="panel max-h-[calc(100dvh-1.5rem-env(safe-area-inset-bottom))] w-full max-w-sm overflow-y-auto overscroll-contain shadow-lux motion-safe:animate-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gold-rule h-px opacity-50" aria-hidden />
        <div className="p-5">
          <p className="eyebrow">Type a command</p>
          <h2 id={headingId} className="mt-2 text-[17px] font-semibold leading-snug tracking-tight text-foreground/87">
            {problem ? problem.title : 'What would you like to do?'}
          </h2>
          {problem && (
            <div id={problemId} role="alert" className="mt-3 rounded-xl border border-warning/35 bg-warning/10 p-3">
              <p className="text-sm leading-relaxed text-foreground/87">{problem.message}</p>
              {problem.help && (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-foreground/60">
                  {problem.help.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <label htmlFor={inputId} className={`${caption} mt-4 block`}>
            {problem ? 'Type it instead' : "Type what you'd say"}
          </label>
          <textarea
            ref={inputRef}
            id={inputId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            maxLength={300}
            // Straight into typing when it was opened to type; a problem is read first.
            autoFocus={!problem}
            disabled={sending}
            placeholder={examples[0] ? `e.g. ${examples[0]}` : undefined}
            className="mt-1.5 block min-h-11 w-full resize-none rounded-lg border border-input bg-background/60 p-3 text-sm text-foreground/87 placeholder:text-foreground/38 focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          <ExamplePhrases
            examples={examples}
            disabled={sending}
            onPick={(phrase) => {
              onChange(phrase);
              inputRef.current?.focus();
            }}
          />

          {sending && <VoiceProgress step="understanding" origin="typed" className="mt-4" />}

          <p className="mt-4 text-[11px] leading-relaxed text-foreground/38">
            What you type goes to Google's Gemini AI service, outside the UAE, to work out what you mean. Nothing changes until you confirm.
          </p>

          <div className="mt-4 space-y-2">
            <button
              type="button"
              className="btn btn-primary inline-flex h-12 w-full items-center justify-center gap-2 text-base font-semibold"
              onClick={send}
              disabled={sending || !value.trim()}
            >
              <Send className="h-4 w-4" aria-hidden />
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button type="button" className="btn btn-ghost min-h-11 w-full" onClick={onCancel} disabled={sending}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
