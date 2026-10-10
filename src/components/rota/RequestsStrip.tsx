import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { weekDays, type IsoDate, type WeekDocDto, type WeekRequestDto } from '../../../shared/rotaWeek';
import { cellId, cellOf, leaveLabel, requestCells, shiftLabel, shortDay, type WeekIndex } from '@/engine/rotaGrid';
import { btn } from './Dialog';

/**
 * Requests and flags above the grid (B1 strip, A3 requests-tray item):
 * pending time off and swaps with Approve / Decline, approved leave (locked
 * cells), and uncovered days. Hover or focus highlights the item's cells in
 * the grid; the builder scrolls them into view. Approve goes through the
 * confirm sheet; the builder does the write.
 */

export type StripAction =
  | { kind: 'approveTimeOff'; request: WeekRequestDto }
  | { kind: 'declineTimeOff'; request: WeekRequestDto }
  | { kind: 'approveSwap'; request: WeekRequestDto }
  | { kind: 'declineSwap'; request: WeekRequestDto };

interface LeaveRun {
  userId: string;
  type: WeekDocDto['leaves'][number]['type'];
  dates: IsoDate[];
}

/** Approved-request leave grouped into consecutive runs per person ("Tue 6 – Thu 8"). */
function approvedRuns(week: WeekDocDto): LeaveRun[] {
  const days = weekDays(week.weekStart);
  const runs: LeaveRun[] = [];
  const byUser = new Map<string, WeekDocDto['leaves']>();
  for (const l of week.leaves) if (l.fromRequest) byUser.set(l.userId, [...(byUser.get(l.userId) ?? []), l]);
  for (const [userId, leaves] of byUser) {
    const sorted = [...leaves].sort((a, b) => a.date.localeCompare(b.date));
    let cur: LeaveRun | null = null;
    for (const l of sorted) {
      const prev = cur?.dates[cur.dates.length - 1];
      if (cur && prev && cur.type === l.type && days.indexOf(l.date) === days.indexOf(prev) + 1) cur.dates.push(l.date);
      else {
        cur = { userId, type: l.type, dates: [l.date] };
        runs.push(cur);
      }
    }
  }
  return runs;
}

const span = (dates: IsoDate[]) => (dates.length === 1 ? shortDay(dates[0]!) : `${shortDay(dates[0]!)} – ${shortDay(dates[dates.length - 1]!)}`);

export function RequestsStrip(props: {
  week: WeekDocDto;
  idx: WeekIndex;
  names: Map<string, string>;
  active: string | null;
  disabled: boolean;
  onHighlight: (key: string | null, cells: string[]) => void;
  onAction: (a: StripAction) => void;
}) {
  const { week, idx, names, active, disabled, onHighlight, onAction } = props;
  const days = weekDays(week.weekStart);
  const person = (id: string | null | undefined) => (id ? week.people.find((p) => p.id === id) : undefined);
  const pending = week.requests.filter((r) => r.status === 'pending' && r.dates.some((d) => days.includes(d)));
  const runs = approvedRuns(week);
  const uncovered = week.coverage.flatMap((c) => c.uncovered.filter((u) => u.short > 0).map((u) => ({ date: c.date, ...u })));

  if (pending.length === 0 && runs.length === 0 && uncovered.length === 0) {
    return <p className="rounded-[14px] border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">No requests or uncovered days this week.</p>;
  }

  const tray = (key: string, cells: string[], body: React.ReactNode, extra?: string) => (
    <div
      key={key}
      tabIndex={0}
      onMouseEnter={() => onHighlight(key, cells)}
      onMouseLeave={() => onHighlight(null, [])}
      onFocus={() => onHighlight(key, cells)}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-[14px] border bg-surface-raised px-3 py-2.5 outline-none motion-safe:transition-colors focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_70%,transparent)]',
        active === key ? 'border-accent' : (extra ?? 'border-border'),
      )}
    >
      {body}
    </div>
  );

  const head = (initials: string, title: string, sub: string, pill: React.ReactNode, ochre = false) => (
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full border bg-surface text-xs font-bold', ochre ? 'border-dashed border-[var(--rota-ochre)] text-[var(--rota-ochre)]' : 'border-border-strong')}>
        {initials}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-[13px] font-semibold', ochre && 'text-[var(--rota-ochre)]')}>{title}</span>
        <span className="truncate text-xs text-muted-foreground">{sub}</span>
      </span>
      {pill}
    </div>
  );
  const pill = (label: string, tone: 'ochre' | 'gold' | 'sage') => (
    <span
      className={cn(
        'shrink-0 rounded-full border px-[7px] py-px text-[10px] font-bold uppercase leading-[1.4] tracking-[0.06em]',
        tone === 'ochre' && 'border-[color-mix(in_oklab,var(--rota-ochre)_55%,transparent)] text-[var(--rota-ochre)]',
        tone === 'gold' && 'border-accent/55 text-accent',
        tone === 'sage' && 'border-success/55 text-success',
      )}
    >
      {label}
    </span>
  );
  const actions = (approve: () => void, decline: () => void, approveLabel = 'Approve') => (
    <div className="flex gap-1.5">
      <button type="button" disabled={disabled} onClick={approve} className={cn(btn.base, btn.sm, btn.gold, 'flex-1')}>
        {approveLabel}
      </button>
      <button type="button" disabled={disabled} onClick={decline} className={cn(btn.base, btn.sm, btn.plain, 'flex-1')}>
        Decline
      </button>
    </div>
  );

  return (
    <section aria-label="Requests and flags" className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2">
      {pending.map((r) => {
        const cells = requestCells(week, r);
        const p = person(r.userId);
        if (r.kind === 'timeOff') {
          const inWeek = r.dates.filter((d) => days.includes(d));
          const now = inWeek
            .map((d) => cellOf(idx, d, r.userId).shifts[0])
            .filter(Boolean)
            .map((s) => shiftLabel(s!, week.shiftTypes, week.clock).split(' ')[0]);
          const sub = `${span(inWeek)} off${now.length ? ` · now ${[...new Set(now)].join(', ')}` : ''}${r.reason ? ` · ${r.reason}` : ''}`;
          return tray(
            `req:${r.id}`,
            cells,
            <>
              {head(p?.initials ?? '?', p?.fullName ?? 'Someone', sub, pill('Time off', 'ochre'))}
              {actions(
                () => onAction({ kind: 'approveTimeOff', request: r }),
                () => onAction({ kind: 'declineTimeOff', request: r }),
              )}
            </>,
          );
        }
        const from = week.shifts.find((s) => s.id === r.shiftId);
        const to = r.targetShiftId ? week.shifts.find((s) => s.id === r.targetShiftId) : undefined;
        const target = person(r.targetUserId);
        const title = `${names.get(r.userId) ?? p?.fullName ?? 'Someone'} ↔ ${target ? (names.get(target.id) ?? target.fullName) : 'anyone'}`;
        const what = [from, to].filter(Boolean).map((s) => shiftLabel(s!, week.shiftTypes, week.clock).split(' ')[0]);
        const sub = `${span(r.dates.filter((d) => days.includes(d)))}${what.length ? ` · ${what.join(' ↔ ')}` : ''}`;
        return tray(
          `req:${r.id}`,
          cells,
          <>
            {head(`${p?.initials.charAt(0) ?? '?'}${target?.initials.charAt(0) ?? ''}`, title, sub, pill('Swap', 'gold'))}
            {actions(
              () => onAction({ kind: 'approveSwap', request: r }),
              () => onAction({ kind: 'declineSwap', request: r }),
              'Approve swap',
            )}
          </>,
        );
      })}
      {runs.map((run) => {
        const p = person(run.userId);
        const key = `leave:${run.userId}:${run.dates[0]}`;
        return tray(
          key,
          run.dates.map((d) => cellId(d, run.userId)),
          <>
            {head(p?.initials ?? '?', `${names.get(run.userId) ?? p?.fullName ?? 'Someone'} · ${leaveLabel(run.type)}`, `${span(run.dates)} · approved`, pill('Locked', 'sage'))}
            <span className="text-xs text-muted-foreground">Cells are locked; decline the leave to edit them.</span>
          </>,
        );
      })}
      {uncovered.map((u) => {
        const dept = week.departments.find((d) => d.id === u.departmentId);
        const key = `unc:${u.date}:${u.departmentId}`;
        return tray(
          key,
          [cellId(u.date, null)],
          <>
            {head('!', `${dept?.name ?? 'Open'} · ${shortDay(u.date)} needs ${u.short}`, 'Drop a person on the open shift, or a shift on someone free', pill('Open', 'ochre'), true)}
            <button type="button" onClick={() => onHighlight(key, [cellId(u.date, null)])} className={cn(btn.base, btn.sm, btn.plain)}>
              <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" /> Show in grid
            </button>
          </>,
          'border-[color-mix(in_oklab,var(--rota-ochre)_45%,transparent)]',
        );
      })}
    </section>
  );
}
