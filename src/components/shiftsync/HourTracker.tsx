import type { ReactNode } from 'react';
import { Clock3, LogIn, LogOut } from 'lucide-react';
import { OfflineActionNotice } from './OfflineNotice';

/**
 * Clock in / out on the Scheduling tab. Rota v2 scope rule: rota surfaces
 * show no hours totals, contract bars or overtime — this panel only records
 * the moment someone starts and stops (attendance stays its own concern;
 * the rota never reads it).
 */
export function HourTracker({
  currentEmployeeName,
  clockedIn,
  onClockIn,
  onClockOut,
  online = true,
  targetPicker,
}: {
  currentEmployeeName?: string;
  clockedIn?: boolean;
  onClockIn?: () => void;
  onClockOut?: () => void;
  /** A stale clock-in/out landing minutes or hours later than the real moment it happened is a real compliance/payroll problem — blocked outright while offline, same as every other write path. */
  online?: boolean;
  /** Managers clocking someone in on their behalf pick who here. */
  targetPicker?: ReactNode;
}) {
  return (
    <section className="panel animate-rise p-4 sm:p-5">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Attendance</p>
          <h2 className="truncate text-base font-semibold tracking-tight">Clock in / out</h2>
        </div>
        <Clock3 className="h-5 w-5 shrink-0 text-accent" />
      </header>

      {targetPicker && <div className="mt-3">{targetPicker}</div>}

      {currentEmployeeName && (onClockIn || onClockOut) ? (
        <div className="mt-4 rounded-lg border border-border bg-background/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium">{currentEmployeeName}</span>
            {clockedIn ? (
              <button onClick={onClockOut} disabled={!online} className="hit-44 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60">
                <LogOut className="h-3.5 w-3.5" /> Clock out
              </button>
            ) : (
              <button onClick={onClockIn} disabled={!online} className="hit-44 inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60">
                <LogIn className="h-3.5 w-3.5" /> Clock in
              </button>
            )}
          </div>
          {!online && <OfflineActionNotice />}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Nobody to clock in yet.</p>
      )}
    </section>
  );
}
