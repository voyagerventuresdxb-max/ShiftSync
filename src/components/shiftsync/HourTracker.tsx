import { Gauge } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface HourTrackerStaff {
  id: string;
  name: string;
  hours: number;
  contract: number;
}

export function HourTracker({ staff }: { staff: HourTrackerStaff[] }) {
  return (
    <section className="panel animate-rise p-4 sm:p-5">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Compliance</p>
          <h2 className="truncate text-base font-semibold tracking-tight">Hour Transparency</h2>
        </div>
        <Gauge className="h-5 w-5 shrink-0 text-accent" />
      </header>

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
