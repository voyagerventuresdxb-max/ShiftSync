import { Check, Timer, X } from 'lucide-react';
import type { SwapRequestStatus } from '../../engine/types';
import { cn } from '../../lib/utils';

export interface ApprovalRequestView {
  id: string;
  status: SwapRequestStatus;
  requesterName: string;
  coveringName: string;
  shiftLabel: string;
  requestedAt: string;
}

const statusMeta: Record<Exclude<SwapRequestStatus, 'pending'>, { label: string; className: string }> = {
  approved: { label: 'Approved · shift reassigned', className: 'border-success/30 bg-success/10 text-success' },
  denied: { label: 'Declined', className: 'border-border-strong bg-muted text-muted-foreground' },
};

export function ApprovalsPanel({
  requests,
  onApprove,
  onDeny,
}: {
  requests: ApprovalRequestView[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const pending = requests.filter((r) => r.status === 'pending');
  const decided = requests.filter((r) => r.status !== 'pending');

  return (
    <section className="panel animate-rise overflow-hidden">
      <header className="border-b border-border p-4 sm:p-5">
        <p className="eyebrow">Request window</p>
        <h2 className="truncate text-base font-semibold tracking-tight">Conflict-Free Approvals</h2>
      </header>

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
              <div className="mt-3 flex gap-2">
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
            </li>
          ))}

          {decided.map((r) => (
            <li key={r.id} className="p-4 sm:p-5">
              <p className="text-sm font-semibold">{r.requesterName}</p>
              <p className="text-sm text-muted-foreground">{r.shiftLabel}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Proposed cover: <span className="font-medium text-foreground">{r.coveringName}</span>
              </p>
              <span
                className={cn(
                  'mt-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium',
                  statusMeta[r.status as Exclude<SwapRequestStatus, 'pending'>].className,
                )}
              >
                {statusMeta[r.status as Exclude<SwapRequestStatus, 'pending'>].label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
