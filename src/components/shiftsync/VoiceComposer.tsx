import { useId, useRef } from 'react';
import type { VoiceProblem } from '@/lib/voiceErrors';

const caption = 'text-[11px] font-medium uppercase tracking-[0.14em] text-foreground/60';

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
 * The typed command, inside the voice sheet: opened from the keyboard button (on the dock or the
 * sheet), and on every voice problem (microphone off, offline, timeout, assistant unavailable,
 * limit reached), which it shows above the box in plain words. What is typed goes through the
 * same reading, preview and Confirm as a spoken command. The sheet around it carries the step
 * (its live region) and the way out (its Cancel).
 */
export function VoiceComposer({
  value,
  onChange,
  problem,
  sending,
  examples,
  onSend,
  headingId,
}: {
  value: string;
  onChange: (text: string) => void;
  /** Why the box opened instead of (or after) the voice flow; null when opened to type. */
  problem: VoiceProblem | null;
  /** The typed command is being read (parse-intent in flight). */
  sending: boolean;
  examples: string[];
  onSend: (text: string) => void;
  /** The sheet is named by this heading. */
  headingId: string;
}) {
  const inputId = useId();
  const problemId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const text = value.trim();
    if (text && !sending) onSend(text);
  };

  return (
    <div aria-describedby={problem ? problemId : undefined}>
      <p className="eyebrow">Type a command</p>
      <h2 id={headingId} className="mt-2 text-[19px] font-semibold leading-snug tracking-tight text-foreground/87">
        {problem ? problem.title : 'What would you like to do?'}
      </h2>
      {problem && (
        <div id={problemId} role="alert" className="mt-3 rounded-2xl border border-warning/35 bg-warning/10 p-3.5">
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

      <label htmlFor={inputId} className={`${caption} mt-5 block`}>
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
        rows={3}
        maxLength={300}
        // Straight into typing when it was opened to type; a problem is read first.
        autoFocus={!problem}
        disabled={sending}
        placeholder={examples[0] ? `e.g. ${examples[0]}` : undefined}
        className="mt-2 block min-h-11 w-full resize-none rounded-2xl border border-input bg-surface px-4 py-3 text-[17px] leading-relaxed text-foreground/87 placeholder:text-foreground/50 focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
      {/* Only while the box is empty: once there are words, they are the command. */}
      {!value.trim() && (
        <ExamplePhrases
          examples={examples}
          disabled={sending}
          onPick={(phrase) => {
            onChange(phrase);
            inputRef.current?.focus();
          }}
        />
      )}

      <p className="mt-4 text-[12px] leading-relaxed text-foreground/60">
        What you type goes to Google's Gemini AI service, outside the UAE, to work out what you mean. Nothing changes until you confirm.
      </p>
      <button
        type="button"
        className="btn btn-primary mt-4 inline-flex h-12 w-full items-center justify-center gap-2 text-base font-semibold"
        onClick={send}
        disabled={sending || !value.trim()}
      >
        {sending ? 'Checking…' : 'Show preview'}
      </button>
    </div>
  );
}
