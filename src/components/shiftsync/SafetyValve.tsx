import { useState } from 'react';
import { ShieldCheck, Send } from 'lucide-react';
import { ApiError, submitFloorFeedback } from '../../api/floorFeedback';
import { useIdentity } from '../../state/IdentityContext';

export function SafetyValve() {
  const { session } = useIdentity();
  const [sent, setSent] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!session) return;
    const content = text.trim();
    if (!content) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitFloorFeedback(session.token, content);
      // Only confirm once the server has actually stored it — a one-way,
      // non-undoable action where correctness matters more than perceived
      // speed, so this stays pessimistic rather than flipping `sent`
      // before the request resolves (same reasoning as StaffDirectory's
      // add/edit flow).
      setSent(true);
      setText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit that feedback.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel animate-rise p-4 sm:p-5">
      <header className="flex min-w-0 items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-signal" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">Direct Floor Feedback</h2>
          <p className="text-xs text-muted-foreground">
            Anonymous to management · your identity isn't shown to managers, though submissions are logged for moderation
          </p>
        </div>
      </header>

      {sent ? (
        <p className="mt-4 rounded-lg border border-signal/25 bg-signal/10 p-3 text-sm text-signal">
          Sent anonymously — your management team can see it and will follow up if needed.
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
            disabled={submitting}
            placeholder="Share a concern about scheduling, breaks, or the floor — safely and anonymously."
            className="mt-2.5 w-full resize-none rounded-lg border border-input bg-background/60 p-3 text-sm placeholder:text-muted-foreground focus:border-signal/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          {error && (
            <div className="error-block mt-2.5" role="alert">
              <p>{error}</p>
            </div>
          )}
          <button
            disabled={!text.trim() || submitting}
            onClick={() => void handleSubmit()}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-signal/40 bg-signal/10 px-4 py-2 text-sm font-semibold text-signal transition-all duration-200 hover:bg-signal/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" /> {submitting ? 'Submitting…' : 'Submit anonymously'}
          </button>
        </>
      )}
    </section>
  );
}
