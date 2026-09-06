import { useEffect, useState } from 'react';
import { ChevronDown, Flag, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  fetchFloorFeedback,
  decideFloorFeedback,
  ApiError,
  type FloorFeedbackDto,
} from '../../api/floorFeedback';
import { useIdentity } from '../../state/IdentityContext';
import { useConnectivity } from '../../state/ConnectivityContext';
import { StaleDataNotice, OfflineEmptyState, OfflineActionNotice } from './OfflineNotice';

function FeedbackRowSkeleton() {
  return (
    <li className="p-4 sm:p-5" aria-hidden>
      <div className="h-3.5 w-24 animate-pulse rounded bg-muted" />
      <div className="mt-2 h-3.5 w-full max-w-md animate-pulse rounded bg-muted" />
      <div className="mt-1.5 h-3.5 w-2/3 max-w-sm animate-pulse rounded bg-muted" />
    </li>
  );
}

/**
 * Manager-facing review queue for SafetyValve's floor feedback. Follows
 * PendingApprovals' pessimistic pattern (disable + inline "…" state, no
 * optimism) rather than ApprovalsPanel's optimistic one — moderation
 * decisions here are low-frequency and correctness/traceability matter more
 * than perceived speed, same reasoning as the submit side.
 *
 * Never receives or renders a submitter identity — the API itself never
 * selects `userId` for this endpoint (see floorFeedback.ts), so there is
 * nothing here to accidentally display even by mistake.
 */
export default function FloorFeedbackReview() {
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const [items, setItems] = useState<FloorFeedbackDto[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True when the most recent load attempt failed — distinguishes an
  // offline cold-load empty state from a genuine "nothing submitted" one.
  const [loadFailed, setLoadFailed] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const load = () => {
    if (!session) {
      setLoading(false);
      return;
    }
    fetchFloorFeedback(session.token)
      .then((list) => {
        setItems(list);
        setError(null);
        setLoadFailed(false);
      })
      .catch((err) => {
        // `items` is left untouched (Phase 2 of the offline-support pass: a
        // failed reload must not blank out data already on screen).
        setError(err instanceof ApiError ? err.message : 'Could not load floor feedback.');
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleDecide = async (id: string, status: 'flagged' | 'reviewed') => {
    if (!session) return;
    // Blocked outright while offline — no auto-retry; the manager clicks
    // again once back online (buttons re-enable automatically).
    if (!online) return;
    setDecidingId(id);
    setError(null);
    try {
      const updated = await decideFloorFeedback(session.token, id, status);
      setItems((prev) => prev.map((i) => (i.id === id ? updated : i)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that feedback.');
    } finally {
      setDecidingId(null);
    }
  };

  const needsAttention = items.filter((i) => i.status === 'open' || i.status === 'flagged');
  const reviewed = items.filter((i) => i.status === 'reviewed');
  const flaggedCount = items.filter((i) => i.status === 'flagged').length;

  return (
    <section className="panel animate-rise overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-surface-raised/40"
      >
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Anonymous to management</p>
          <h2 className="text-base font-semibold tracking-tight">Floor Feedback</h2>
        </div>
        {flaggedCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning">
            <Flag className="h-3 w-3" /> {flaggedCount} flagged
          </span>
        )}
        {needsAttention.length > 0 && flaggedCount === 0 && (
          <span className="rounded-full border border-border-strong bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {needsAttention.length}
          </span>
        )}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          {error && (
            <div className="error-block mx-4 mb-2" role="alert">
              <p>{error}</p>
            </div>
          )}

          {!online && items.length > 0 && <StaleDataNotice />}

          {loading ? (
            <ul className="divide-y divide-border" aria-busy="true" aria-label="Loading floor feedback">
              <FeedbackRowSkeleton />
              <FeedbackRowSkeleton />
            </ul>
          ) : items.length === 0 ? (
            !online && loadFailed ? (
              <OfflineEmptyState message="You're offline — floor feedback couldn't be loaded yet." />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">No floor feedback submitted yet.</p>
            )
          ) : (
            <ul className="divide-y divide-border">
              {needsAttention.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    'p-4 sm:p-5',
                    // Flagged items need follow-up — visually distinguished
                    // from a plain open item rather than reading identically.
                    item.status === 'flagged' && 'border-l-2 border-warning bg-warning/5',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </p>
                    {item.status === 'flagged' && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                        <Flag className="h-3 w-3" /> Needs follow-up
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm">{item.content}</p>
                  <div className="mt-3 flex gap-2">
                    {item.status === 'open' && (
                      <button
                        onClick={() => void handleDecide(item.id, 'flagged')}
                        disabled={decidingId === item.id || !online}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-warning/40 px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Flag className="h-3.5 w-3.5" /> Flag
                      </button>
                    )}
                    <button
                      onClick={() => void handleDecide(item.id, 'reviewed')}
                      disabled={decidingId === item.id || !online}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {decidingId === item.id ? 'Saving…' : 'Mark reviewed'}
                    </button>
                  </div>
                  {!online && <OfflineActionNotice />}
                </li>
              ))}

              {reviewed.map((item) => (
                <li key={item.id} className="p-4 sm:p-5 opacity-70">
                  <p className="text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm">{item.content}</p>
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Reviewed{item.reviewedByName ? ` · ${item.reviewedByName}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
