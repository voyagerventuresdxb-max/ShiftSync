import { weekDays, type WeekDocDto } from '../../../../shared/rotaWeek';
import { cn } from '../../../lib/utils';
import { matrixGroups, matrixLegend, type MatrixKind } from './matrixModel';
import { dayOfMonth, isWeekend, longDate, shortWeekday, venueNow, weekRangeLabel } from './weekModel';

/**
 * Read-only Team Matrix: person × day codes (M / D / E / S, Off, Leave,
 * Sick; a double shows both codes) derived from the same week document the
 * grid uses, so the two can never disagree (Design board E). Keeps the old
 * Team Matrix's look — panel, initials, code cells — with department
 * groups, a pinned name column and today's column marked.
 */
export interface WeekMatrixProps {
  week: WeekDocDto;
}

const kindStyles: Record<MatrixKind, string> = {
  shift: 'bg-accent/15 text-accent border-accent/25',
  double: 'bg-accent text-accent-foreground border-accent',
  off: 'bg-muted text-muted-foreground border-border',
  leave: 'border-dashed border-border-strong text-muted-foreground',
  sick: 'border-destructive/40 text-destructive',
};

const legendKinds: { label: string; kind: MatrixKind }[] = [
  { label: 'Shift', kind: 'shift' },
  { label: 'Double', kind: 'double' },
  { label: 'Off', kind: 'off' },
  { label: 'Leave', kind: 'leave' },
  { label: 'Sick', kind: 'sick' },
];

export function WeekMatrix({ week }: WeekMatrixProps) {
  const days = weekDays(week.weekStart);
  const today = venueNow(week.timezone).date;
  const groups = matrixGroups(week);
  const legend = matrixLegend(week.shiftTypes);
  const cols = 'grid-cols-[9.5rem_repeat(7,minmax(4.5rem,1fr))]';

  return (
    <section className="panel animate-rise overflow-hidden" aria-label="Team Matrix">
      <header className="border-b border-border p-4">
        <p className="eyebrow">{weekRangeLabel(days[0]!, days[6]!)}</p>
        <h2 className="truncate text-lg font-semibold tracking-tight">Team Matrix</h2>
      </header>

      <div className="overflow-x-auto overscroll-x-contain">
        <div role="table" aria-label={`Team Matrix, week of ${longDate(week.weekStart)}`} className="min-w-[640px]">
          <div role="row" className={cn('grid border-b border-border bg-background/40', cols)}>
            <div role="columnheader" className="eyebrow sticky left-0 z-10 bg-surface p-3">
              Staff
            </div>
            {days.map((d) => (
              <div
                key={d}
                role="columnheader"
                aria-label={longDate(d)}
                className={cn(
                  'p-3 text-center text-xs font-medium tabular-nums',
                  d === today ? 'bg-accent/10 font-semibold text-accent' : 'text-muted-foreground',
                  d !== today && isWeekend(d) && 'bg-foreground/[0.03]',
                )}
              >
                {shortWeekday(d)} {dayOfMonth(d)}
              </div>
            ))}
          </div>

          {groups.map(({ group, rows }) => (
            <div key={group.id} role="rowgroup" aria-label={`${group.name}, ${rows.length} people`}>
              <div role="row" className="border-b border-border/60 bg-background/30">
                <div role="rowheader" className="sticky left-0 inline-flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: `var(--rota-${group.tint})` }} />
                  {group.name} · {rows.length}
                </div>
              </div>
              {rows.map(({ person, cells }) => (
                <div key={person.id} role="row" className={cn('grid border-b border-border/60 transition-colors last:border-0 hover:bg-surface-raised/60', cols)}>
                  <div role="rowheader" className="sticky left-0 z-10 flex min-w-0 items-center gap-2.5 bg-surface p-3">
                    <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border-strong bg-muted text-[11px] font-semibold">
                      {person.initials}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium leading-tight">{person.fullName}</span>
                      {person.roleTitle && <span className="block truncate text-[11px] text-muted-foreground">{person.roleTitle}</span>}
                    </span>
                  </div>
                  {cells.map((cell, i) => {
                    const d = days[i]!;
                    return (
                      <div key={d} role="cell" className={cn('p-1.5', d === today && 'bg-accent/[0.06]')}>
                        <div
                          title={cell.detail}
                          aria-label={`${person.fullName}, ${longDate(d)}, ${cell.detail}`}
                          className={cn('grid min-h-10 place-items-center rounded-md border px-1 text-center text-[11px] font-semibold tracking-wide', kindStyles[cell.kind])}
                        >
                          {cell.code}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="p-5 text-sm text-muted-foreground">No one is on the team for this week yet.</p>}
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border p-4">
        {legend.map((l) => (
          <span key={l.code + l.name} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <b className="font-semibold text-foreground">{l.code}</b>
            {l.name}
          </span>
        ))}
        <span aria-hidden="true" className="hidden h-3 w-px bg-border sm:block" />
        {legendKinds.map((l) => (
          <span key={l.label} className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn('h-3 w-3 rounded-sm border', kindStyles[l.kind])} />
            {l.label}
          </span>
        ))}
      </footer>
    </section>
  );
}
