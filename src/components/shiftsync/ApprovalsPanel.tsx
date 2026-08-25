import { useEffect, useState } from 'react';
import { Check, ChevronDown, FileText, Lock, Timer, X } from 'lucide-react';
import type { SwapRequestStatus } from '../../engine/types';
import { cn } from '../../lib/utils';

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

export function ApprovalsPanel({
  requests,
  onApprove,
  onDeny,
}: {
  requests: ApprovalRequestView[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = requests.filter((r) => r.status === 'pending');
  const decided = requests.filter((r) => r.status !== 'pending');
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

          {requests.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <Timer className="h-5 w-5 text-muted-foreground" />
              No shift-swap requests yet. Requests raised from Personal Rota will appear here for approval.
            </div>
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
                      <div className="flex gap-2">
                        <button
                          onClick={() => onApprove(r.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-transform duration-200 hover:scale-[1.03]"
                        >
                          <Check className="h-3.5 w-3.5" /> Approve
                        </button>
                        <button
                          onClick={() => onDeny(r.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium transition-colors hover:border-destructive/40 hover:text-destructive"
                        >
                          <X className="h-3.5 w-3.5" /> Decline
                        </button>
                      </div>
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
