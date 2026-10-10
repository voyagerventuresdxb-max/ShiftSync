import { memo, type ReactNode, type Ref } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { initialsOf, type IsoDate, type WeekDocDto, type WeekPersonDto, type WeekShiftDto, type ShiftTypeDto } from '../../../shared/rotaWeek';
import {
  cellId,
  cellOf,
  coverageView,
  dayMonth,
  dropRing,
  isWeekend,
  leaveLabel,
  roleLine,
  shortDay,
  type DragSource,
  type DropVerdict,
  type PersonGroup,
  type WeekIndex,
  type CellContents,
} from '@/engine/rotaGrid';
import { ShiftChip, StatusChip, shiftAccessibleName, type Clock } from './chips';

/**
 * The week grid (Design board B1; Spec §1, §6): sticky day header and
 * coverage row, collapsible department groups with a sticky name column,
 * one droppable cell per person-day (`${date}|${userId}`, the old builder's
 * scheme) and an open-shifts row. Cells are the tab stops (roving tabindex);
 * chips inside them are the draggables. Everything that changes the week is
 * a callback: this component never writes.
 */

export interface GridDrag {
  source: DragSource;
  overId: string | null;
  verdict: DropVerdict | null;
}

export interface WeekGridProps {
  week: WeekDocDto;
  idx: WeekIndex;
  groups: PersonGroup[];
  collapsed: Record<string, boolean>;
  onToggleGroup: (id: string) => void;
  days: IsoDate[];
  today: IsoDate;
  clock: Clock;
  compact: boolean;
  tablet: boolean;
  /** Offline, or nothing to place: no drag, no add affordance. */
  readOnly: boolean;
  /** No shift types yet: the people show greyed under the setup prompt (B8). */
  dimmed: boolean;
  focusId: string | null;
  selection: ReadonlySet<string>;
  highlight: ReadonlySet<string>;
  drag: GridDrag | null;
  onCellClick: (id: string, e: React.MouseEvent) => void;
  onCellFocus: (id: string) => void;
  onChipOpen: (shiftId: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelectRow: (userId: string | null, additive: boolean) => void;
  onSelectColumn: (date: IsoDate, additive: boolean) => void;
  onCoverageJump: (date: IsoDate, departmentId: string) => void;
  /** Rendered as a full-width row after the second person row (B8 empty week prompt). */
  prompt?: ReactNode;
  gridRef: Ref<HTMLDivElement>;
}

const ROW = 'grid grid-cols-[var(--namew)_repeat(7,minmax(var(--colw),1fr))] min-w-[calc(var(--namew)_+_7*var(--colw))]';
const NAME_CELL = 'sticky start-0 z-[2] flex min-w-0 items-center gap-2.5 border-e border-b border-e-border-strong border-b-border/60 bg-surface px-2.5';

function avatar(initials: string, extra?: string) {
  return (
    <span aria-hidden="true" className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border-strong bg-surface-raised text-xs font-bold text-foreground', extra)}>
      {initials}
    </span>
  );
}

export function WeekGrid(props: WeekGridProps) {
  const { week, idx, groups, collapsed, onToggleGroup, days, today, tablet, gridRef, prompt } = props;
  const openShifts = week.shifts.filter((s) => s.userId === null);
  const visibleRows = groups.reduce((n, g) => n + 1 + (collapsed[g.id] ? 0 : g.people.length), 0) + 1 + (collapsed.open ? 0 : 1);
  let personRowCount = 0;
  let promptShown = false;

  const renderPrompt = () => {
    if (!prompt || promptShown) return null;
    promptShown = true;
    return (
      <div role="row" className="min-w-[calc(var(--namew)_+_7*var(--colw))] border-b border-border/60">
        <div role="gridcell" aria-colspan={8} className="sticky start-0 w-full max-w-[min(100%,720px)] p-3">
          {prompt}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label={`Week of ${dayMonth(days[0]!)}, staff by day`}
      aria-rowcount={visibleRows + 2}
      aria-colcount={8}
      onKeyDown={props.onKeyDown}
      className={cn(
        'relative max-h-[calc(100dvh-210px)] min-h-[360px] overflow-auto overscroll-contain rounded-[14px] border border-border bg-background',
        tablet && 'snap-x snap-proximity scroll-ps-[var(--namew)]',
      )}
      style={{ '--namew': tablet ? '150px' : '200px', '--colw': tablet ? '124px' : '108px' } as React.CSSProperties}
    >
      {/* Day header */}
      <div role="row" aria-rowindex={1} className={cn(ROW, 'sticky top-0 z-[4] border-b border-border-strong bg-surface')}>
        <div role="columnheader" className="sticky start-0 z-[5] flex h-12 items-center border-e border-border-strong bg-surface px-2.5">
          <span className="eyebrow">Staff · {groups.reduce((n, g) => n + g.people.length, 0)}</span>
        </div>
        {days.map((d) => {
          const isToday = d === today;
          return (
            <div
              key={d}
              role="columnheader"
              aria-label={`${dayMonth(d)}${isToday ? ', today' : ''}`}
              className={cn(
                'flex h-12 min-w-0 snap-start border-e border-border/60',
                isWeekend(d) ? 'bg-[color-mix(in_oklab,var(--text)_3.5%,var(--surface))]' : 'bg-surface',
                isToday && 'shadow-[inset_0_-2px_0_var(--accent)]',
              )}
            >
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => props.onSelectColumn(d, e.shiftKey || e.metaKey || e.ctrlKey)}
                title="Select this day"
                className="flex h-full w-full flex-col justify-center px-2.5 text-left"
              >
                <span className={cn('whitespace-nowrap text-[13px] font-bold tabular-nums', isToday && 'text-accent')}>{shortDay(d)}</span>
                <span className="whitespace-nowrap text-[11px] tracking-[0.04em] text-muted-foreground">
                  {isToday ? 'Today' : isWeekend(d) ? 'Weekend' : new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* Coverage row */}
      <div role="row" aria-rowindex={2} className={cn(ROW, 'sticky top-12 z-[3] border-b border-border-strong bg-surface')}>
        <div role="rowheader" className="sticky start-0 z-[5] flex h-14 items-center border-e border-border-strong bg-surface px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Coverage
        </div>
        {days.map((d) => {
          const cov = coverageView(
            week.coverage.find((c) => c.date === d),
            week.departments,
          );
          return (
            <div
              key={d}
              role="gridcell"
              className={cn(
                'flex h-14 min-w-0 flex-col items-start justify-center gap-1 border-e border-border/60 px-2.5 text-xs tabular-nums text-muted-foreground',
                isWeekend(d) ? 'bg-[color-mix(in_oklab,var(--text)_3.5%,var(--surface))]' : 'bg-surface',
              )}
            >
              <span className="whitespace-nowrap">
                <b className="font-semibold text-foreground">{cov.on}</b> on · {cov.off} off
              </span>
              {cov.short.length === 0 ? (
                <span className="rounded-full border border-success/55 px-[7px] py-px text-[10px] font-bold uppercase leading-[1.4] tracking-[0.06em] text-success">Covered</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {cov.short.slice(0, 2).map((s) => (
                    <button
                      key={s.departmentId}
                      type="button"
                      tabIndex={-1}
                      onClick={() => props.onCoverageJump(d, s.departmentId)}
                      aria-label={`Uncovered: ${s.label.replace('−', 'needs ')} on ${dayMonth(d)}. Show.`}
                      className="hit-44 inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--rota-ochre)_55%,transparent)] px-[7px] py-px text-[10px] font-bold uppercase leading-[1.4] tracking-[0.06em] text-[var(--rota-ochre)]"
                    >
                      <AlertTriangle aria-hidden="true" className="h-[11px] w-[11px]" />
                      {s.label}
                    </button>
                  ))}
                  {cov.short.length > 2 && <span className="text-[10px] font-bold text-[var(--rota-ochre)]">+{cov.short.length - 2}</span>}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {groups.map((g) => {
        const isOpen = !collapsed[g.id];
        const onToday = days.includes(today) ? g.people.filter((p) => cellOf(idx, today, p.id).shifts.length > 0).length : null;
        const summary = isOpen ? (onToday === null ? '' : `${onToday} on today`) : g.people.map((p) => p.fullName.split(/\s+/)[0]).join(', ');
        return (
          <div key={g.id} role="rowgroup" aria-label={`${g.name}, ${g.people.length} ${g.people.length === 1 ? 'person' : 'people'}`}>
            <div role="row" className="sticky top-[104px] z-[2] flex min-w-[calc(var(--namew)_+_7*var(--colw))] items-center gap-2.5 border-y border-t-border-strong border-b-border/60 bg-surface">
              <div role="rowheader" aria-colspan={8} className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => onToggleGroup(g.id)}
                  aria-expanded={isOpen}
                  className="sticky start-0 z-[2] flex min-h-11 items-center gap-2.5 bg-surface px-2.5 text-[13px] font-bold tracking-[0.04em]"
                >
                  <ChevronDown aria-hidden="true" className={cn('h-4 w-4 text-muted-foreground motion-safe:transition-transform', !isOpen && '-rotate-90')} />
                  <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--rota-${g.tint})` }} />
                  <span>{g.name}</span>
                  <span className="text-xs font-semibold text-muted-foreground">
                    {g.people.length} {g.people.length === 1 ? 'person' : 'people'}
                  </span>
                </button>
                <span className="truncate text-xs text-muted-foreground">{summary}</span>
              </div>
            </div>
            {isOpen &&
              g.people.map((p) => {
                personRowCount++;
                const row = (
                  <PersonRow key={p.id} person={p} {...props} />
                );
                if (personRowCount === 2) {
                  return (
                    <div key={p.id} className="contents">
                      {row}
                      {renderPrompt()}
                    </div>
                  );
                }
                return row;
              })}
          </div>
        );
      })}
      {renderPrompt()}

      {/* Open shifts */}
      <div role="rowgroup" aria-label={`Open shifts, ${openShifts.length} uncovered`}>
        <div role="row" className="sticky top-[104px] z-[2] flex min-w-[calc(var(--namew)_+_7*var(--colw))] items-center gap-2.5 border-y border-t-border-strong border-b-border/60 bg-surface">
          <div role="rowheader" aria-colspan={8}>
            <button
              type="button"
              onClick={() => onToggleGroup('open')}
              aria-expanded={!collapsed.open}
              className="sticky start-0 z-[2] flex min-h-11 items-center gap-2.5 bg-surface px-2.5 text-[13px] font-bold tracking-[0.04em]"
            >
              <ChevronDown aria-hidden="true" className={cn('h-4 w-4 text-muted-foreground motion-safe:transition-transform', collapsed.open && '-rotate-90')} />
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full border border-dashed border-[var(--rota-ochre)]" />
              <span>Open shifts</span>
              <span className={cn('text-xs font-semibold', openShifts.length ? 'text-[var(--rota-ochre)]' : 'text-muted-foreground')}>{openShifts.length} uncovered</span>
            </button>
          </div>
        </div>
        {!collapsed.open && <PersonRow person={null} {...props} />}
      </div>
      <div className="h-6" aria-hidden="true" />
    </div>
  );
}

function PersonRow(props: WeekGridProps & { person: WeekPersonDto | null }) {
  const { person, week, idx, days, today, clock, compact, tablet, readOnly, dimmed, focusId, selection, highlight, drag } = props;
  const userId = person?.id ?? null;
  const weekPublished = week.publishedAt !== null;
  const name = person?.fullName ?? 'Open shift';
  return (
    <div role="row" className={cn(ROW, dimmed && 'opacity-60')}>
      <div role="rowheader" className={cn(NAME_CELL, compact ? 'py-1' : 'py-2')}>
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => props.onSelectRow(userId, e.shiftKey || e.metaKey || e.ctrlKey)}
          title={person ? `Select ${person.fullName}'s week` : 'Select the open-shifts row'}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          {person ? avatar(person.initials || initialsOf(person.fullName), compact || tablet ? 'h-7 w-7 text-[11px]' : undefined) : avatar('+', 'border-dashed text-[var(--rota-ochre)]')}
          <span className="flex min-w-0 flex-col">
            <span className={cn('truncate font-semibold', compact ? 'text-[13px]' : 'text-sm')} title={name}>
              {person ? person.fullName : 'Unassigned'}
              {person && !person.isActive && <span className="ms-1 text-[11px] font-medium text-muted-foreground">(left)</span>}
            </span>
            {!compact && !tablet && <span className="truncate text-[11px] text-muted-foreground">{person ? roleLine(person, week.departments) : 'Drop a person here'}</span>}
          </span>
        </button>
      </div>
      {days.map((d) => {
        const id = cellId(d, userId);
        const contents = cellOf(idx, d, userId);
        const cov = week.coverage.find((c) => c.date === d);
        const uncovered = userId === null && (contents.shifts.length > 0 || (cov?.uncovered.some((u) => u.short > 0) ?? false));
        const isSource = drag?.source.kind === 'shift' && !drag.source.copy && contents.shifts.some((s) => drag.source.kind === 'shift' && s.id === drag.source.shiftId);
        return (
          <GridCell
            key={d}
            id={id}
            date={d}
            personName={person?.fullName ?? null}
            contents={contents}
            types={week.shiftTypes}
            clock={clock}
            compact={compact}
            weekPublished={weekPublished}
            today={d === today}
            weekend={isWeekend(d)}
            past={d < today}
            readOnly={readOnly}
            focused={focusId === id}
            selected={selection.has(id)}
            highlighted={highlight.has(id)}
            uncovered={uncovered}
            source={isSource}
            ring={drag && drag.overId === id && drag.verdict ? dropRing(drag.verdict) : undefined}
            onClick={props.onCellClick}
            onFocus={props.onCellFocus}
            onChipOpen={props.onChipOpen}
          />
        );
      })}
    </div>
  );
}

interface CellProps {
  id: string;
  date: IsoDate;
  personName: string | null;
  contents: CellContents;
  types: ShiftTypeDto[];
  clock: Clock;
  compact: boolean;
  weekPublished: boolean;
  today: boolean;
  weekend: boolean;
  past: boolean;
  readOnly: boolean;
  focused: boolean;
  selected: boolean;
  highlighted: boolean;
  uncovered: boolean;
  source: boolean;
  ring: 'ok' | 'conflict' | 'invalid' | undefined;
  onClick: (id: string, e: React.MouseEvent) => void;
  onFocus: (id: string) => void;
  onChipOpen: (shiftId: string) => void;
}

/** The sentence a screen reader hears for a cell (Spec §3: built once per render). */
function cellName(p: Pick<CellProps, 'personName' | 'date' | 'contents' | 'types'>): string {
  const { personName, date, contents, types } = p;
  const who = personName ?? 'Open shifts';
  const parts: string[] = [];
  if (contents.shifts.length > 0) {
    parts.push(contents.shifts.map((s) => shiftAccessibleName({ personName, date, shift: s, types })).join('; '));
  } else {
    parts.push(`${who}, ${dayMonth(date)}`);
    if (contents.leave) parts.push(`${leaveLabel(contents.leave.type)}${contents.leave.fromRequest ? ', approved leave, locked' : ''}`);
    else parts.push(personName ? 'empty' : 'none');
  }
  if (contents.pendingRequest) parts.push('time off requested');
  return parts.join(', ');
}

const GridCell = memo(function GridCell(p: CellProps) {
  const { ref } = useDroppable({ id: p.id, disabled: p.readOnly || p.past });
  const { contents } = p;
  const leave = contents.leave;
  const empty = contents.shifts.length === 0 && !leave && !contents.pendingRequest;
  const visible = contents.shifts.slice(0, contents.userId === null ? 3 : 2);
  return (
    <div
      ref={ref}
      role="gridcell"
      data-cell={p.id}
      tabIndex={p.focused ? 0 : -1}
      aria-selected={p.selected}
      aria-label={cellName(p)}
      onClick={(e) => p.onClick(p.id, e)}
      onFocus={() => p.onFocus(p.id)}
      className={cn(
        'rota-cell group border-e border-b border-border/60 outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_70%,transparent)]',
        p.source && 'outline-1 -outline-offset-4 outline-dashed outline-border-strong',
        p.past && 'opacity-75',
      )}
      data-today={p.today ? 'true' : undefined}
      data-weekend={p.weekend ? 'true' : undefined}
      data-selected={p.selected ? 'true' : undefined}
      data-highlight={p.highlighted ? 'true' : undefined}
      data-drop={p.ring}
      data-uncovered={p.uncovered ? 'true' : undefined}
      data-compact={p.compact ? 'true' : undefined}
    >
      {visible.map((s) => (
        <DraggableChip
          key={s.id}
          shift={s}
          types={p.types}
          clock={p.clock}
          compact={p.compact || contents.shifts.length + (leave || contents.pendingRequest ? 1 : 0) > 1}
          weekPublished={p.weekPublished}
          disabled={p.readOnly || p.past}
          onOpen={p.onChipOpen}
        />
      ))}
      {contents.shifts.length > visible.length && <span className="text-[11px] font-semibold text-[var(--rota-ochre)]">+{contents.shifts.length - visible.length} more</span>}
      {leave && (
        <StatusChip
          type={leave.type}
          compact={p.compact || contents.shifts.length > 0}
          requested={!!contents.pendingRequest}
          locked={leave.fromRequest}
          edited={p.weekPublished && leave.status === 'draft'}
        />
      )}
      {!leave && contents.pendingRequest && <StatusChip type="OFF_REQUESTED" compact={p.compact || contents.shifts.length > 0} />}
      {empty && !p.readOnly && !p.past && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-1.5 grid place-items-center rounded-[10px] border border-dashed border-border-strong text-lg text-muted-foreground opacity-0 motion-safe:transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          +
        </span>
      )}
    </div>
  );
});

const DraggableChip = memo(function DraggableChip(p: {
  shift: WeekShiftDto;
  types: ShiftTypeDto[];
  clock: Clock;
  compact: boolean;
  weekPublished: boolean;
  disabled: boolean;
  onOpen: (shiftId: string) => void;
}) {
  const { ref, isDragging } = useDraggable({ id: `shift:${p.shift.id}`, data: { kind: 'shift', shiftId: p.shift.id }, disabled: p.disabled });
  return (
    <div
      ref={ref}
      data-chip={p.shift.id}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        p.onOpen(p.shift.id);
      }}
      className={cn(
        'w-full touch-manipulation select-none rounded-[10px] outline-none [-webkit-touch-callout:none]',
        !p.disabled && 'cursor-grab',
        isDragging && 'cursor-grabbing shadow-[0_8px_22px_color-mix(in_oklab,var(--bg)_70%,transparent)] ring-1 ring-accent',
      )}
    >
      <ShiftChip shift={p.shift} types={p.types} clock={p.clock} compact={p.compact} weekPublished={p.weekPublished} />
    </div>
  );
});
