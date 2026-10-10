import type { CSSProperties } from 'react';
import { weekDays, type IsoDate, type ShiftTint, type WeekDocDto } from '../../../../shared/rotaWeek';
import { cn } from '../../../lib/utils';
import { shiftTint } from '../chips';
import { dayOfMonth, displayNames, groupPeople, longDate, personDay, shortWeekday, typeCodes } from '../staff/weekModel';
import { actionLabel, brushesOf, sameAction, tileFor, tileForAction, type CellAction, type TileLabel } from './phoneModel';

function tileStyle(tile: TileLabel, tint: ShiftTint | null): CSSProperties | undefined {
  if (tile.tone === 'shift' && tint) {
    return {
      background: `color-mix(in oklab, var(--rota-${tint}) 26%, transparent)`,
      borderColor: `color-mix(in oklab, var(--rota-${tint}) 42%, transparent)`,
    };
  }
  if (tile.tone === 'leave') return { borderColor: 'color-mix(in oklab, var(--rota-sand) 55%, transparent)', color: 'var(--rota-sand)', background: 'color-mix(in oklab, var(--rota-sand) 8%, transparent)' };
  if (tile.tone === 'sick') return { borderColor: 'color-mix(in oklab, var(--rota-clay) 65%, transparent)', color: 'var(--rota-clay)' };
  if (tile.tone === 'half') return { borderColor: 'color-mix(in oklab, var(--rota-gold) 35%, transparent)' };
  return undefined;
}

/**
 * Paint mode (Design board B3, "Phone-Paint"): pick a brush, tap tiles. Taps
 * land on screen at once (shown as pending) and go to the server in batches
 * — see ManagerPhoneRota for the batching rule. Five days fit at 390 px; the
 * grid scrolls sideways for the weekend with the name column pinned.
 * Long-press drag is not offered on the phone: every tile is a plain tap
 * target, which keeps sideways scrolling unambiguous.
 */
export function PhonePaintView(props: {
  week: WeekDocDto;
  brush: CellAction;
  /** Taps not yet confirmed by the server, by "userId|date". */
  pending: Map<string, CellAction>;
  lastKey: string | null;
  today: IsoDate;
  disabled: boolean;
  onBrush: (action: CellAction) => void;
  onPaint: (userId: string, date: IsoDate) => void;
  onUndo: () => void;
  canUndo: boolean;
  onDone: () => void;
}) {
  const { week, brush, pending, lastKey, today, disabled, onBrush, onPaint, onUndo, canUndo, onDone } = props;
  const brushes = brushesOf(week);
  const current = brushes.find((b) => sameAction(b.action, brush)) ?? brushes[0]!;
  const days = weekDays(week.weekStart);
  const groups = groupPeople(week);
  const names = displayNames(groups.flatMap((g) => g.people));
  const codes = typeCodes(week.shiftTypes);
  const brushName = actionLabel(brush, week.shiftTypes);

  return (
    <div className="flex flex-col gap-2.5">
      <div role="status" aria-live="polite" className="flex items-center gap-2.5 rounded-2xl border border-accent bg-accent/12 py-1.5 pl-3.5 pr-1.5">
        <span
          aria-hidden="true"
          className="h-[22px] w-2.5 shrink-0 rounded-[3px] border border-foreground/25"
          style={current.tint ? { background: `color-mix(in oklab, var(--rota-${current.tint}) 75%, transparent)`, borderColor: 'transparent' } : undefined}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          Painting: <span className="text-accent">{brushName}</span>
        </span>
        <button type="button" onClick={onUndo} disabled={!canUndo || disabled} aria-label="Undo last paint" className="min-h-11 shrink-0 rounded-xl border border-border-strong bg-surface px-3 text-[13px] font-semibold disabled:opacity-45">
          Undo
        </button>
        <button type="button" onClick={onDone} className="min-h-11 shrink-0 rounded-xl bg-accent px-4 text-[13px] font-semibold text-accent-foreground">
          Done
        </button>
      </div>

      <div role="radiogroup" aria-label="Brush" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 py-1">
        {brushes.map((b) => {
          const on = sameAction(b.action, brush);
          return (
            <button
              key={b.name + (b.action.kind === 'type' ? b.action.shiftTypeId : '')}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onBrush(b.action)}
              className={cn(
                'inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border bg-surface py-0 pl-2 pr-3 text-[13px] font-semibold',
                on ? 'border-accent ring-2 ring-accent/35' : 'border-border-strong',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('h-5 w-2.5 rounded-[3px]', !b.tint && 'border', b.action.kind === 'erase' || (b.action.kind === 'leave' && b.action.type === 'DAY_OFF') ? 'border-dashed border-foreground/40' : 'border-foreground/40')}
                style={b.tint ? { background: `color-mix(in oklab, var(--rota-${b.tint}) 75%, transparent)` } : undefined}
              />
              {b.name}
            </button>
          );
        })}
      </div>

      <div className="-mx-4 overflow-x-auto overscroll-x-contain px-4 [scroll-snap-type:x_proximity]">
        <div role="grid" aria-label={`Week of ${longDate(week.weekStart)}`} aria-rowcount={groups.reduce((n, g) => n + g.people.length, 0) + 1} aria-colcount={8} className="grid w-max grid-cols-[74px_repeat(7,46px)] items-center gap-0.5">
          <div role="row" className="contents">
            <div role="columnheader" className="sticky left-0 z-10 flex h-11 items-center bg-background text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
              Staff
            </div>
            {days.map((d) => {
              const cov = week.coverage.find((c) => c.date === d);
              const short = cov ? cov.uncovered.reduce((n, u) => n + u.short, 0) : 0;
              return (
                <div
                  key={d}
                  role="columnheader"
                  aria-label={`${longDate(d)}${cov ? `, ${cov.on} on` : ''}${short ? `, needs ${short} more` : ''}`}
                  className={cn('flex h-11 snap-start flex-col items-center justify-center text-[11px] font-bold leading-tight tabular-nums', d === today ? 'text-accent' : 'text-muted-foreground')}
                >
                  <span>
                    {shortWeekday(d)} {dayOfMonth(d)}
                  </span>
                  <span className="whitespace-nowrap text-[10px] font-semibold" style={short ? { color: 'var(--rota-ochre)' } : undefined}>
                    {cov ? (short ? `${cov.on} · −${short}` : `${cov.on} on`) : ''}
                  </span>
                </div>
              );
            })}
          </div>

          {groups.map((g) => (
            <div key={g.id} role="rowgroup" aria-label={g.name} className="contents">
              <div role="presentation" className="col-span-8 flex h-[26px] items-center pt-1.5">
                <span className="sticky left-0 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: `var(--rota-${g.tint})` }} />
                  {g.name}
                </span>
              </div>
              {g.people.map((p) => (
                <div key={p.id} role="row" className="contents">
                  <div role="rowheader" title={p.fullName} className="sticky left-0 z-10 flex h-11 items-center truncate bg-background pr-1 text-xs font-semibold">
                    {names.get(p.id) ?? p.fullName}
                  </div>
                  {days.map((d) => {
                    const key = `${p.id}|${d}`;
                    const day = personDay(week, p.id, d);
                    const queued = pending.get(key);
                    const tile = queued ? tileForAction(queued, week.shiftTypes, codes) : tileFor(day, week.shiftTypes, codes);
                    const tint: ShiftTint | null = queued
                      ? queued.kind === 'type'
                        ? (week.shiftTypes.find((t) => t.id === queued.shiftTypeId)?.tint ?? null)
                        : null
                      : day.shifts[0]
                        ? shiftTint(day.shifts[0], week.shiftTypes)
                        : null;
                    return (
                      <button
                        key={d}
                        type="button"
                        role="gridcell"
                        disabled={disabled}
                        onClick={() => onPaint(p.id, d)}
                        aria-label={`${p.fullName}, ${longDate(d)}, ${tile.spoken}${day.locked ? ', approved time off, locked' : ''}${day.pendingRequest ? ', time off requested' : ''}${queued ? ', saving' : ''}. Paint ${brushName}.`}
                        style={tileStyle(tile, tint)}
                        className={cn(
                          'relative flex h-11 w-[46px] flex-col items-center justify-center gap-0.5 rounded-lg border text-xs font-bold leading-none transition-opacity disabled:cursor-not-allowed',
                          tile.tone === 'off' && 'border-dashed border-foreground/18 text-muted-foreground',
                          tile.tone === 'empty' && 'border-dashed border-foreground/8 text-muted-foreground',
                          tile.tone === 'unpaid' && 'border-foreground/18 text-muted-foreground',
                          (tile.tone === 'shift' || tile.tone === 'half') && 'text-foreground',
                          tile.tone === 'shift' && !tint && 'border-foreground/18',
                          d === today && 'shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_35%,transparent)]',
                          queued && 'opacity-70',
                          lastKey === key && 'ring-2 ring-accent',
                          day.pendingRequest && !queued && 'outline-1 outline-offset-[-3px] outline-dashed [outline-color:var(--rota-ochre)]',
                        )}
                      >
                        <span>{tile.code}</span>
                        {tile.sub && <small className="text-[8px] font-semibold tracking-[0.02em] opacity-75">{tile.sub}</small>}
                        {day.locked && <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full" style={{ background: 'var(--rota-sand)' }} />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Five days fit; swipe the grid sideways for the weekend. Tap a tile to paint {brushName} onto it. Days with a time-off request ask before a shift goes on them; approved time off stays locked.
      </p>
    </div>
  );
}
