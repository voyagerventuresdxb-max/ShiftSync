import { useEffect, useState } from 'react';
import { Check, ChevronDown, FileText, Lock, Timer, X } from 'lucide-react';
import type { SwapRequestStatus } from '../../engine/types';
import { cn } from '../../lib/utils';
import { useConnectivity } from '../../state/ConnectivityContext';
import { StaleDataNotice, OfflineEmptyState, OfflineActionNotice } from './OfflineNotice';

export interface ApprovalRequestView {
  id: string;
  status: SwapRequestStatus;
  requesterName: string;
  coveringName: string;
  shiftLabel: string;
  requestedAt: string;
  expiresAt: string;
  locked: boolean;
  auditNote?: string;
}

function useCountdown(target: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const diff = Math.max(0, target - now);
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function ApprovalRowSkeleton() {
  return (
    <li className="p-4 sm:p-5" aria-hidden>
      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      <div className="mt-2 h-3.5 w-48 animate-pulse rounded bg-muted" />
      <div className="mt-2 h-3 w-40 animate-pulse rounded bg-muted" />
      <div className="mt-3 flex gap-2">
        <div className="h-7 w-24 animate-pulse rounded-lg bg-muted" />
        <div className="h-7 w-24 animate-pulse rounded-lg bg-muted" />
      </div>
    </li>
  );
}

export function ApprovalsPanel({
  requests,
  loading = false,
  loadFailed = false,
  onApprove,
  onDeny,
}: {
  requests: ApprovalRequestView[];
  /** True only for the initial fetch — never for an in-flight approve/decide (that has its own per-row spinner, see `decide` below). */
  loading?: boolean;
  /** True when the most recent fetch failed — distinguishes an offline cold-load empty state from a genuine "no requests" one. */
  loadFailed?: boolean;
  onApprove: (id: string) => Promise<void>;
  onDeny: (id: string) => Promise<void>;
}) {
  const { online } = useConnectivity();
  const [open, setOpen] = useState(false);
  // Optimistic status override, keyed by request id — set the instant
  // Approve/Decline is clicked so the row moves to "decided" immediately,
  // rather than sitting in "pending" until the parent's post-decide
  // refetch lands. Cleared on both success (server truth has already
  // replaced `requests` by then, via the refetch inside
  // handleDecideRequest's `finally`) and failure (so the row falls back to
  // whatever `requests` says — the same refetch keeps that current too,
  // typically still 'pending'). `rowErrors` is the per-row message for the
  // last decide attempt that failed.
  const [optimisticStatus, setOptimisticStatus] = useState<Record<string, 'approved' | 'denied'>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const clearOptimistic = (id: string) =>
    setOptimisticStatus((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const decide = async (id: string, action: 'approve' | 'deny') => {
    // Blocked outright rather than attempted-then-rolled-back: this is
    // shift/staffing coordination, where a decision that actually lands
    // minutes or hours later than the manager thinks it did is worse than
    // no decision at all. No auto-retry — the manager clicks again once
    // back online (the buttons re-enable automatically via `online`).
    if (!online) return;
    setRowErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setOptimisticStatus((prev) => ({ ...prev, [id]: action === 'approve' ? 'approved' : 'denied' }));
    try {
      if (action === 'approve') await onApprove(id);
      else await onDeny(id);
      clearOptimistic(id);
    } catch (err) {
      clearOptimistic(id);
      setRowErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Could not process that request.',
      }));
    }
  };

  const viewRows = requests.map((r) =>
    optimisticStatus[r.id] ? { ...r, status: optimisticStatus[r.id] } : r,
  );
  const pending = viewRows.filter((r) => r.status === 'pending');
  const decided = viewRows.filter((r) => r.status !== 'pending');
  const nextClose = requests.length > 0 ? Math.max(...requests.map((r) => new Date(r.expiresAt).getTime())) : Date.now();
  const remaining = useCountdown(nextClose);

  return (
    <section className="panel animate-rise overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 p-4 text-left transition-colors hover:bg-surface-raised/40 sm:p-5"
      >
        <div className="min-w-0">
          <p className="eyebrow">Request window</p>
          <h2 className="truncate text-base font-semibold tracking-tight">Conflict-Free Approvals</h2>
        </div>
        {requests.length > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent">
            <Timer className="h-3 w-3" />
            <span className="tabular-nums">{remaining}</span>
          </span>
        )}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          <p className="border-b border-border px-4 pb-4 text-xs text-muted-foreground sm:px-5">
            Requests close Wednesday 17:00 GST. Overlapping requests auto-lock to protect published coverage.
          </p>

          {!online && requests.length > 0 && <StaleDataNotice />}

          {loading ? (
            <ul className="divide-y divide-border" aria-busy="true" aria-label="Loading approvals">
              <ApprovalRowSkeleton />
              <ApprovalRowSkeleton />
            </ul>
          ) : requests.length === 0 ? (
            !online && loadFailed ? (
              <OfflineEmptyState message="You're offline — approvals couldn't be loaded yet." />
            ) : (
              <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
                <Timer className="h-5 w-5 text-muted-foreground" />
                No shift-swap requests yet. Requests raised from Personal Rota will appear here for approval.
              </div>
            )
          ) : (
            <ul className="divide-y divide-border">
              {pending.map((r) => (
                <li key={r.id} className="p-4 sm:p-5">
                  <p className="text-sm font-semibold">{r.requesterName}</p>
                  <p className="text-sm text-muted-foreground">{r.shiftLabel}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Proposed cover: <span className="font-medium text-foreground">{r.coveringName}</span>
                  </p>
                  <div className="mt-3">
                    {r.locked ? (
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive">
                        <Lock className="h-3.5 w-3.5" /> Auto-locked — this shift was already reassigned
                      </span>
                    ) : (
                      <>
                        <div className="flex gap-2">
                          <button
                            onClick={() => void decide(r.id, 'approve')}
                            disabled={!online}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Check className="h-3.5 w-3.5" /> Approve
                          </button>
                          <button
                            onClick={() => void decide(r.id, 'deny')}
                            disabled={!online}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <X className="h-3.5 w-3.5" /> Decline
                          </button>
                        </div>
                        {!online && <OfflineActionNotice />}
                        {rowErrors[r.id] && (
                          <div className="error-block mt-2" role="alert">
                            <p>{rowErrors[r.id]}</p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}

              {decided.map((r) => (
                <li key={r.id} className="p-4 sm:p-5">
                  <p className="text-sm font-semibold">{r.requesterName}</p>
                  <p className="text-sm text-muted-foreground">{r.shiftLabel}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Proposed cover: <span className="font-medium text-foreground">{r.coveringName}</span>
                  </p>
                  {r.auditNote && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <FileText className="mt-0.5 h-3 w-3 shrink-0" /> {r.auditNote}
                    </p>
                  )}
                  <span
                    className={cn(
                      'mt-2 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium',
                      r.status === 'approved'
                        ? 'border-success/30 bg-success/10 text-success'
                        : 'border-border-strong bg-muted text-muted-foreground',
                    )}
                  >
                    {r.status === 'approved' ? 'Approved · shift reassigned' : 'Declined'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
