import { useState } from 'react';
import { ArrowLeftRight, CheckCircle2, Clock, LayoutGrid, MapPin, Moon, StickyNote } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useConnectivity } from '../../state/ConnectivityContext';
import { OfflineActionNotice } from './OfflineNotice';

export type RotaStatus = 'confirmed' | 'draft' | 'off' | 'swap-pending';

export interface RotaCard {
  id: string;
  day: string;
  date: string;
  venue: string;
  role: string;
  start: string;
  end: string;
  hours: number;
  status: RotaStatus;
  briefingNote?: string;
  sidework?: string[];
  /** "Terrace (AM)"-style labels for this day's PUBLISHED Floor Plan section assignments, if any — DRAFT assignments never appear here. Empty/omitted means no assignment yet, not "loading". */
  sectionAssignments?: string[];
}

export interface CoverCandidate {
  id: string;
  name: string;
}

const statusMeta: Record<RotaStatus, { label: string; className: string }> = {
  confirmed: { label: 'Confirmed', className: 'bg-success/12 text-success border-success/25' },
  // An unpublished shift is not a promise yet — it shares the warning tone
  // with 'swap-pending' so "do not rely on this line" reads the same way.
  draft: { label: 'Draft — not yet published', className: 'bg-warning/12 text-warning border-warning/25' },
  off: { label: 'Rest day', className: 'bg-muted text-muted-foreground border-border' },
  'swap-pending': { label: 'Swap pending', className: 'bg-warning/12 text-warning border-warning/25' },
};

function ShiftCard({
  shift,
  index,
  coverCandidates,
  onRequestCover,
}: {
  shift: RotaCard;
  index: number;
  coverCandidates: CoverCandidate[];
  onRequestCover?: (shiftId: string, coveringEmployeeId: string) => Promise<void>;
}) {
  const { online } = useConnectivity();
  const meta = statusMeta[shift.status];
  const isOff = shift.status === 'off';
  const [requesting, setRequesting] = useState(false);
  const [coveringId, setCoveringId] = useState(coverCandidates[0]?.id ?? '');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const sendRequest = async () => {
    if (!onRequestCover) return;
    // Blocked outright while offline — no auto-retry; the button re-enables
    // once back online and the staff member sends it again manually.
    if (!online) return;
    setSending(true);
    setSendError(null);
    try {
      await onRequestCover(shift.id, coveringId);
      // Only flip to the "sent" confirmation once the server has actually
      // accepted the request — flipping it beforehand risked telling the
      // staff member their request went through when it hadn't.
      setSent(true);
      setRequesting(false);
    } catch (err) {
      // Stay on the picker (pre-confirmation state) and show why, rather
      // than silently doing nothing or falsely confirming.
      setSendError(err instanceof Error ? err.message : 'Could not send that cover request.');
    } finally {
      setSending(false);
    }
  };

  return (
    <article
      className="panel animate-rise overflow-hidden transition-all duration-300 hover:border-border-strong hover:shadow-lux"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-4 p-4 sm:p-5">
        <div
          className={cn(
            'flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-lg border transition-colors',
            isOff
              ? 'border-border bg-muted text-muted-foreground'
              : 'border-accent/30 bg-accent/10 text-accent',
          )}
        >
          <span className="eyebrow leading-none">{shift.day}</span>
          <span className="mt-1 text-sm font-semibold leading-none">{shift.date}</span>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-base font-semibold tracking-tight">
              {shift.role}
            </h3>
            {!isOff && (
              <span
                className={cn(
                  'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  meta.className,
                )}
              >
                {meta.label}
              </span>
            )}
          </div>

          {isOff ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Moon className="h-3.5 w-3.5 shrink-0" /> No shift scheduled.
            </p>
          ) : (
            <>
              {shift.venue && (
                <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{shift.venue}</span>
                </p>
              )}
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="inline-flex items-center gap-2 font-medium tabular-nums">
                  <Clock className="h-3.5 w-3.5 text-accent" />
                  {shift.start} – {shift.end}
                </span>
                <span className="text-muted-foreground tabular-nums">{shift.hours.toFixed(1)}h</span>
              </p>

              {shift.sectionAssignments && shift.sectionAssignments.length > 0 && (
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-accent" />
                  You're covering: {shift.sectionAssignments.join(', ')}
                </p>
              )}

              {shift.briefingNote && (
                <div className="mt-3 rounded-lg border border-border bg-background/50 p-3">
                  <p className="eyebrow flex items-center gap-1.5">
                    <StickyNote className="h-3 w-3" /> Briefing
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{shift.briefingNote}</p>
                </div>
              )}

              {shift.sidework && shift.sidework.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {shift.sidework.map((task) => (
                    <li key={task} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
                      <span>{task}</span>
                    </li>
                  ))}
                </ul>
              )}

              {onRequestCover && coverCandidates.length > 0 && (
                <div className="mt-3">
                  {sent ? (
                    <p className="text-xs text-success">Cover request sent — awaiting manager approval.</p>
                  ) : requesting ? (
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={coveringId}
                          onChange={(e) => setCoveringId(e.target.value)}
                          disabled={sending}
                          className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground disabled:opacity-60"
                        >
                          {coverCandidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => void sendRequest()}
                          disabled={sending || !online}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {sending && <span className="spinner" aria-hidden />}
                          {sending ? 'Sending…' : 'Send request'}
                        </button>
                        <button
                          onClick={() => {
                            setRequesting(false);
                            setSendError(null);
                          }}
                          disabled={sending}
                          className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                      {!online && <OfflineActionNotice />}
                      {sendError && (
                        <div className="error-block mt-2" role="alert">
                          <p>{sendError}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => setRequesting(true)}
                        disabled={!online}
                        className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                        Request cover
                      </button>
                      {!online && <OfflineActionNotice />}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function ShiftCardSkeleton({ index }: { index: number }) {
  return (
    <article
      className="panel animate-rise overflow-hidden"
      style={{ animationDelay: `${index * 60}ms` }}
      aria-hidden
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-4 p-4 sm:p-5">
        <div className="h-16 w-14 shrink-0 animate-pulse rounded-lg bg-muted" />
        <div className="min-w-0 flex-1 space-y-2 py-1">
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="h-3 w-40 animate-pulse rounded bg-muted" />
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </article>
  );
}

export function PersonalRota({
  shifts,
  coverCandidates = [],
  onRequestCover,
  loading = false,
}: {
  shifts: RotaCard[];
  coverCandidates?: CoverCandidate[];
  onRequestCover?: (shiftId: string, coveringEmployeeId: string) => Promise<void>;
  /** True only for the initial schedule fetch — not for a week-nav reload. */
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading personal rota">
        {[0, 1, 2, 3].map((i) => (
          <ShiftCardSkeleton key={i} index={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {shifts.map((shift, i) => (
        <ShiftCard
          key={shift.id}
          shift={shift}
          index={i}
          coverCandidates={coverCandidates}
          onRequestCover={onRequestCover}
        />
      ))}
    </div>
  );
}
