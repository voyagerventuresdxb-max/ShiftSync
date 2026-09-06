import { Gauge, LogIn, LogOut } from 'lucide-react';
import { cn } from '../../lib/utils';
import { OfflineActionNotice } from './OfflineNotice';

export interface HourTrackerStaff {
  id: string;
  name: string;
  hours: number;
  contract: number;
}

export function HourTracker({
  staff,
  weekLabel,
  currentEmployeeName,
  clockedIn,
  onClockIn,
  onClockOut,
  online = true,
}: {
  staff: HourTrackerStaff[];
  /** Week these hours belong to. The rota builder's week nav retargets this panel, so without it a future week's 0.0h reads as a bug. */
  weekLabel?: string;
  currentEmployeeName?: string;
  clockedIn?: boolean;
  onClockIn?: () => void;
  onClockOut?: () => void;
  /** A stale clock-in/out landing minutes or hours later than the real moment it happened is a real compliance/payroll problem — blocked outright while offline, same as every other write path in this pass. */
  online?: boolean;
}) {
  return (
    <section className="panel animate-rise p-4 sm:p-5">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Real hours, not the schedule</p>
          <h2 className="truncate text-base font-semibold tracking-tight">Hour Tracking</h2>
          {weekLabel && <p className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">{weekLabel}</p>}
        </div>
        <Gauge className="h-5 w-5 shrink-0 text-accent" />
      </header>

      {currentEmployeeName && (onClockIn || onClockOut) && (
        <div className="mt-4 rounded-lg border border-border bg-background/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium">{currentEmployeeName}</span>
            {clockedIn ? (
              <button onClick={onClockOut} disabled={!online} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60">
                <LogOut className="h-3.5 w-3.5" /> Clock out
              </button>
            ) : (
              <button onClick={onClockIn} disabled={!online} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60">
                <LogIn className="h-3.5 w-3.5" /> Clock in
              </button>
            )}
          </div>
          {!online && <OfflineActionNotice />}
        </div>
      )}

      {staff.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No staff parsed yet.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {staff.map((s) => {
            const pct = Math.min(100, (s.hours / s.contract) * 100);
            const over = s.hours > s.contract;
            const near = !over && pct >= 85;
            return (
              <div key={s.id}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium">{s.name}</span>
                  <span
                    className={cn(
                      'shrink-0 tabular-nums',
                      over ? 'text-destructive' : near ? 'text-warning' : 'text-muted-foreground',
                    )}
                  >
                    {s.hours.toFixed(1)}h / {s.contract}h
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-700 ease-out',
                      over ? 'bg-destructive' : near ? 'bg-warning' : 'bg-accent',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {over && (
                  <p className="mt-1.5 text-[11px] text-destructive">
                    Over contract by {(s.hours - s.contract).toFixed(1)}h — overtime approval required.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
