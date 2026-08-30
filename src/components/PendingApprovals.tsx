import { useEffect, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { fetchPendingJoinRequests, decideJoinRequest, ApiError, type JoinRequestDto } from '../api/join';
import { useIdentity } from '../state/IdentityContext';

/**
 * Pending Approvals — the review queue for JoinRequest rows raised by the
 * phone/OTP join flow (src/api/join.ts) when no existing User auto-matches.
 * Styled after ApprovalsPanel.tsx's collapsible pending/decided pattern,
 * but simpler: a JoinRequestDto has no decided state of its own — once
 * approved/declined it disappears from the pending list entirely, so
 * there's nothing to render in a "decided" section.
 */
export default function PendingApprovals({ locationId }: { locationId: string }) {
  const { session } = useIdentity();
  const [requests, setRequests] = useState<JoinRequestDto[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const load = () => {
    // No session (or a staff session) means this can only ever 401/403 — the
    // route is manager-only now. Skip the request rather than firing one that
    // can't succeed; the list simply stays empty, same as the "nothing
    // pending" state below.
    if (!session) return;
    fetchPendingJoinRequests(session.token, locationId)
      .then(setRequests)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load pending approvals.'));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, session]);

  const handleDecide = async (id: string, decision: 'approve' | 'decline') => {
    if (!session) return;
    setDecidingId(id);
    try {
      await decideJoinRequest(session.token, id, decision);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not process that request.');
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <section className="panel animate-rise overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-surface-raised/40"
      >
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Needs review</p>
          <h2 className="text-base font-semibold tracking-tight">Pending Approvals</h2>
        </div>
        {requests.length > 0 && (
          <span className="rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning">
            {requests.length}
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
          {requests.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No join requests waiting for review.</p>
          ) : (
            <ul className="divide-y divide-border">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.fullName}</p>
                    <p className="text-xs text-muted-foreground">{r.phone}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => void handleDecide(r.id, 'approve')}
                      disabled={decidingId === r.id}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      onClick={() => void handleDecide(r.id, 'decline')}
                      disabled={decidingId === r.id}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium hover:border-destructive/40 hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" /> Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
