import { useState } from 'react';
import { ArrowLeftRight, Clock, MapPin, Moon } from 'lucide-react';
import { cn } from '../../lib/utils';

export type RotaStatus = 'confirmed' | 'off';

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
}

export interface CoverCandidate {
  id: string;
  name: string;
}

const statusMeta: Record<RotaStatus, { label: string; className: string }> = {
  confirmed: { label: 'Confirmed', className: 'bg-success/12 text-success border-success/25' },
  off: { label: 'Rest day', className: 'bg-muted text-muted-foreground border-border' },
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
  onRequestCover?: (shiftId: string, coveringEmployeeId: string) => void;
}) {
  const meta = statusMeta[shift.status];
  const isOff = shift.status === 'off';
  const [requesting, setRequesting] = useState(false);
  const [coveringId, setCoveringId] = useState(coverCandidates[0]?.id ?? '');
  const [sent, setSent] = useState(false);

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

              {onRequestCover && coverCandidates.length > 0 && (
                <div className="mt-3">
                  {sent ? (
                    <p className="text-xs text-success">Cover request sent — awaiting manager approval.</p>
                  ) : requesting ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={coveringId}
                        onChange={(e) => setCoveringId(e.target.value)}
                        className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground"
                      >
                        {coverCandidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          onRequestCover(shift.id, coveringId);
                          setSent(true);
                          setRequesting(false);
                        }}
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
                      >
                        Send request
                      </button>
                      <button
                        onClick={() => setRequesting(false)}
                        className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRequesting(true)}
                      className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent/50 hover:text-accent"
                    >
                      <ArrowLeftRight className="h-3.5 w-3.5" />
                      Request cover
                    </button>
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

export function PersonalRota({
  shifts,
  coverCandidates = [],
  onRequestCover,
}: {
  shifts: RotaCard[];
  coverCandidates?: CoverCandidate[];
  onRequestCover?: (shiftId: string, coveringEmployeeId: string) => void;
}) {
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
