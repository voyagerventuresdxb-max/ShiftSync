import { useState } from 'react';
import { ShieldCheck, Send } from 'lucide-react';

export function SafetyValve() {
  const [sent, setSent] = useState(false);
  const [text, setText] = useState('');

  return (
    <section className="panel animate-rise p-4 sm:p-5">
      <header className="flex min-w-0 items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-signal" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">Direct Floor Feedback</h2>
          <p className="text-xs text-muted-foreground">
            Anonymous to management · no name, device or timestamp attached
          </p>
        </div>
      </header>

      {sent ? (
        <p className="mt-4 rounded-lg border border-signal/25 bg-signal/10 p-3 text-sm text-signal">
          Not connected to a review process yet — this note wasn't sent, stored, or seen by anyone.
        </p>
      ) : (
        <>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Feedback should be constructive and specific — please don't submit anything intended to harm, harass, or target a colleague.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="Share a concern about scheduling, breaks, or the floor — safely and anonymously."
            className="mt-2.5 w-full resize-none rounded-lg border border-input bg-background/60 p-3 text-sm placeholder:text-muted-foreground focus:border-signal/50 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            disabled={!text.trim()}
            onClick={() => setSent(true)}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-signal/40 bg-signal/10 px-4 py-2 text-sm font-semibold text-signal transition-all duration-200 hover:bg-signal/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" /> Submit anonymously
          </button>
        </>
      )}
    </section>
  );
}
