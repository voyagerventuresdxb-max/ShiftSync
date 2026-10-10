import {
  LEAVE_LABELS,
  formatRange,
  rangesEndNextDay,
  weekDays,
  type IsoDate,
  type LeaveTypeCode,
  type ShiftTint,
  type ShiftTypeDto,
  type TimeRange,
  type WeekDocDto,
  type WeekLeaveDto,
  type WeekPatchOp,
  type WeekShiftDto,
} from '../../../../shared/rotaWeek';
import { OTHER_DEPARTMENT, codeOf, dayOfMonth, groupPeople, isWeekend, leaveNeedsClearing, longDate, shortTimes, shortWeekday, typeCodes, type DeptGroup, type PersonDay } from '../staff/weekModel';

/**
 * Pure model for the manager phone views (Design board B3): what a one-tap
 * assignment turns into as week-patch ops, how an action is undone, the
 * week strip, and paint-tile labels. No React here, so every rule is
 * unit-tested.
 */

// ---------------------------------------------------------------------------
// Actions on one person-day
// ---------------------------------------------------------------------------

/** What a tap in the assign sheet or a paint brush does to one person-day. */
export type CellAction = { kind: 'type'; shiftTypeId: string } | { kind: 'leave'; type: LeaveTypeCode } | { kind: 'erase' };

export function sameAction(a: CellAction, b: CellAction): boolean {
  if (a.kind === 'type' && b.kind === 'type') return a.shiftTypeId === b.shiftTypeId;
  if (a.kind === 'leave' && b.kind === 'leave') return a.type === b.type;
  return a.kind === b.kind;
}

/**
 * The ops that make `day` hold `action` — empty when it already does. One
 * live shift per person-day: an existing shift is re-typed in place (keeping
 * its id, history and note), a legacy second shift is removed. A shift may
 * not sit on blocking leave (the server refuses `person_on_leave`), so that
 * leave is cleared first; Day off / Half day give way on their own. Leave may
 * not sit on a shift (`leave_over_shift`), so shifts go first.
 */
export function opsForAction(day: PersonDay, action: CellAction): WeekPatchOp[] {
  const { userId, date, shifts, leave } = day;
  const ops: WeekPatchOp[] = [];
  if (action.kind === 'type') {
    const [first, ...extra] = shifts;
    for (const s of extra) ops.push({ op: 'delete', shiftId: s.id });
    if (first) {
      // Re-typed in place: the server takes the new type's times.
      if (first.shiftTypeId !== action.shiftTypeId) ops.push({ op: 'update', shiftId: first.id, shiftTypeId: action.shiftTypeId });
      return ops;
    }
    if (leaveNeedsClearing(leave)) ops.push({ op: 'clearLeave', userId, date });
    ops.push({ op: 'create', userId, date, shiftTypeId: action.shiftTypeId });
    return ops;
  }
  if (action.kind === 'leave') {
    if (shifts.length === 0 && leave?.type === action.type) return [];
    for (const s of shifts) ops.push({ op: 'delete', shiftId: s.id });
    ops.push({ op: 'setLeave', userId, date, type: action.type });
    return ops;
  }
  for (const s of shifts) ops.push({ op: 'delete', shiftId: s.id });
  if (leave) ops.push({ op: 'clearLeave', userId, date });
  return ops;
}

/** Only placing a shift onto a day with a pending time-off request declines it, so only that needs the confirm sheet. */
export function needsConfirm(day: PersonDay, action: CellAction): boolean {
  return action.kind === 'type' && day.pendingRequest !== null;
}

export function actionLabel(action: CellAction, types: ShiftTypeDto[]): string {
  if (action.kind === 'type') return types.find((t) => t.id === action.shiftTypeId)?.name ?? 'Shift';
  if (action.kind === 'leave') return action.type === 'ANNUAL_LEAVE' ? 'Leave' : LEAVE_LABELS[action.type];
  return 'Cleared';
}

/** "Morning 07:00–16:00", "Day off", "empty" — what a person-day holds now, for sheets and toasts. */
export function describeDay(day: Pick<PersonDay, 'shifts' | 'leave'>, types: ShiftTypeDto[], clock: '12h' | '24h'): string {
  if (day.shifts.length > 0) {
    return day.shifts
      .map((s) => `${types.find((t) => t.id === s.shiftTypeId)?.name ?? 'Custom'} ${s.ranges.map((r) => formatRange(r, clock)).join(' · ')}${s.endsNextDay ? ' +1' : ''}`)
      .join(' and ');
  }
  if (day.leave) return LEAVE_LABELS[day.leave.type];
  return 'Day off';
}

// ---------------------------------------------------------------------------
// Undo: restore the touched person-days and shifts to how they were
// ---------------------------------------------------------------------------

export interface CellSnapshot {
  userId: string;
  date: IsoDate;
  shifts: WeekShiftDto[];
  leave: WeekLeaveDto | null;
}

export interface UndoEntry {
  id: number;
  label: string;
  /** Person-days as they were before the action. */
  cells: CellSnapshot[];
  /** Shifts outside any person-day (open shifts) as they were, keyed by id. */
  openShifts: WeekShiftDto[];
  /** Shifts the action created that no person-day snapshot covers (a duplicate made as an open shift). */
  created: string[];
  /** The action declined a time-off request. Undo restores the cells; the request stays declined (no route reopens it). */
  declinedRequest: boolean;
  /** Paint strokes merge into one entry until Done or a 2 s pause (Spec §2, undo semantics). */
  stroke: string | null;
  at: number;
}

export const STROKE_IDLE_MS = 2000;
export const UNDO_LIMIT = 50;

export function snapshotOf(day: PersonDay | CellSnapshot): CellSnapshot {
  return { userId: day.userId, date: day.date, shifts: day.shifts.map((s) => ({ ...s, ranges: s.ranges.map((r) => ({ ...r })) })), leave: day.leave ? { ...day.leave } : null };
}

const cellKey = (c: { userId: string; date: IsoDate }) => `${c.userId}|${c.date}`;

/** Merge a later entry into an earlier one: the earliest snapshot of each cell/shift wins, so undo returns to before the whole stroke. */
export function mergeEntries(earlier: UndoEntry, later: UndoEntry): UndoEntry {
  const cells = new Map(earlier.cells.map((c) => [cellKey(c), c]));
  for (const c of later.cells) if (!cells.has(cellKey(c))) cells.set(cellKey(c), c);
  const open = new Map(earlier.openShifts.map((s) => [s.id, s]));
  for (const s of later.openShifts) if (!open.has(s.id)) open.set(s.id, s);
  return {
    ...earlier,
    label: later.label,
    cells: [...cells.values()],
    openShifts: [...open.values()],
    created: [...new Set([...earlier.created, ...later.created])],
    declinedRequest: earlier.declinedRequest || later.declinedRequest,
    at: later.at,
  };
}

/** Push onto the undo stack, folding a continuing paint stroke into its entry. */
export function pushUndo(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const top = stack[stack.length - 1];
  if (top && entry.stroke && top.stroke === entry.stroke && entry.at - top.at <= STROKE_IDLE_MS) {
    return [...stack.slice(0, -1), mergeEntries(top, entry)];
  }
  return [...stack, entry].slice(-UNDO_LIMIT);
}

const sameRanges = (a: WeekShiftDto['ranges'], b: WeekShiftDto['ranges']) =>
  a.length === b.length && a.every((r, i) => r.start === b[i]!.start && r.end === b[i]!.end);

/**
 * The inverse patch: ops that put every snapshotted person-day and shift back
 * the way it was, computed against the week as it is NOW (so it also works
 * after a merged paint stroke or a refetch). Order matters to the server's
 * person-day rules: remove what the action added, clear leave it added, move
 * or re-time surviving shifts back, re-create removed ones, then restore
 * leave (which may not sit on a shift).
 */
export function restoreOps(week: Pick<WeekDocDto, 'shifts' | 'leaves'>, entry: Pick<UndoEntry, 'cells' | 'openShifts' | 'created'>): WeekPatchOp[] {
  const before = new Map<string, WeekShiftDto>();
  for (const c of entry.cells) for (const s of c.shifts) before.set(s.id, s);
  for (const s of entry.openShifts) if (!before.has(s.id)) before.set(s.id, s);
  const live = new Map(week.shifts.map((s) => [s.id, s]));

  const deletes = new Set<string>();
  for (const c of entry.cells) {
    for (const s of week.shifts) if (s.userId === c.userId && s.date === c.date && !before.has(s.id)) deletes.add(s.id);
  }
  for (const id of entry.created) if (live.has(id) && !before.has(id)) deletes.add(id);

  const ops: WeekPatchOp[] = [...deletes].map((shiftId) => ({ op: 'delete' as const, shiftId }));
  const leaveNow = (c: CellSnapshot) => week.leaves.find((l) => l.userId === c.userId && l.date === c.date) ?? null;
  for (const c of entry.cells) {
    if (!c.leave && leaveNow(c)) ops.push({ op: 'clearLeave', userId: c.userId, date: c.date });
  }
  for (const b of before.values()) {
    const now = live.get(b.id);
    if (!now) continue;
    if (now.userId === b.userId && now.date === b.date && now.shiftTypeId === b.shiftTypeId && sameRanges(now.ranges, b.ranges) && (now.note ?? null) === (b.note ?? null) && now.roleId === b.roleId && now.departmentId === b.departmentId) continue;
    ops.push({
      op: 'update',
      shiftId: b.id,
      userId: b.userId,
      date: b.date,
      shiftTypeId: b.shiftTypeId,
      ranges: b.ranges.map((r) => ({ ...r })),
      note: b.note,
      ...(now.roleId !== b.roleId ? { roleId: b.roleId } : {}),
      ...(now.departmentId !== b.departmentId ? { departmentId: b.departmentId } : {}),
    });
  }
  for (const b of before.values()) {
    if (live.has(b.id)) continue;
    ops.push({
      op: 'create',
      userId: b.userId,
      roleId: b.roleId,
      departmentId: b.departmentId,
      date: b.date,
      ...(b.shiftTypeId ? { shiftTypeId: b.shiftTypeId } : {}),
      ranges: b.ranges.map((r) => ({ ...r })),
      note: b.note,
    });
  }
  for (const c of entry.cells) {
    if (c.leave && leaveNow(c)?.type !== c.leave.type) ops.push({ op: 'setLeave', userId: c.userId, date: c.date, type: c.leave.type });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Week strip (B3 day pills)
// ---------------------------------------------------------------------------

export interface StripDay {
  date: IsoDate;
  weekday: string;
  day: number;
  /** "10 on", or "−1" when a department is short that day. */
  count: string;
  short: number;
  weekend: boolean;
  today: boolean;
  selected: boolean;
  /** "Saturday 10 October, 9 on, needs 1 more" */
  label: string;
}

export function weekStrip(week: Pick<WeekDocDto, 'coverage'> | null, weekStart: IsoDate, selected: IsoDate, today: IsoDate): StripDay[] {
  return weekDays(weekStart).map((date) => {
    const cov = week?.coverage.find((c) => c.date === date);
    const short = cov ? cov.uncovered.reduce((n, u) => n + u.short, 0) : 0;
    const on = cov?.on ?? 0;
    const count = short > 0 ? `−${short}` : cov ? `${on} on` : '';
    const label = [longDate(date), cov ? `${on} on` : null, short > 0 ? `needs ${short} more` : null].filter(Boolean).join(', ');
    return { date, weekday: shortWeekday(date), day: dayOfMonth(date), count, short, weekend: isWeekend(date), today: date === today, selected: date === selected, label };
  });
}

// ---------------------------------------------------------------------------
// Paint tiles (B3 paint mode)
// ---------------------------------------------------------------------------

export interface TileLabel {
  code: string;
  sub: string;
  /** For styling: a shift tint, or a status. */
  tone: 'shift' | 'off' | 'leave' | 'sick' | 'unpaid' | 'half' | 'empty';
  /** "Morning 07:00 to 16:00", "Annual leave", "empty". */
  spoken: string;
}

const LEAVE_TILE: Record<LeaveTypeCode, Omit<TileLabel, 'spoken'>> = {
  DAY_OFF: { code: '–', sub: 'off', tone: 'off' },
  ANNUAL_LEAVE: { code: 'L', sub: 'leave', tone: 'leave' },
  SICK_LEAVE: { code: 'Sk', sub: 'sick', tone: 'sick' },
  UNPAID_LEAVE: { code: 'U', sub: 'unpaid', tone: 'unpaid' },
  HALF_DAY: { code: '½', sub: 'half', tone: 'half' },
};

export function tileFor(day: Pick<PersonDay, 'shifts' | 'leave'>, types: ShiftTypeDto[], codes: Map<string, string> = typeCodes(types)): TileLabel {
  if (day.shifts.length > 0) {
    const s = day.shifts[0]!;
    const name = types.find((t) => t.id === s.shiftTypeId)?.name ?? 'Custom';
    return {
      code: day.shifts.map((x) => codeOf(x, codes)).join(''),
      sub: shortTimes(s.ranges),
      tone: 'shift',
      spoken: `${name} ${s.ranges.map((r) => `${r.start} to ${r.end}`).join(' and ')}${s.endsNextDay ? ', ends next day' : ''}`,
    };
  }
  if (day.leave) return { ...LEAVE_TILE[day.leave.type], spoken: LEAVE_LABELS[day.leave.type] };
  return { code: '', sub: '', tone: 'empty', spoken: 'empty' };
}

/** What a tile will show once a pending paint lands (optimistic, before the server answers). */
export function tileForAction(action: CellAction, types: ShiftTypeDto[], codes: Map<string, string> = typeCodes(types)): TileLabel {
  if (action.kind === 'type') {
    const t = types.find((x) => x.id === action.shiftTypeId);
    return {
      code: t ? codeOf({ shiftTypeId: t.id, ranges: t.ranges }, codes) : '?',
      sub: t ? shortTimes(t.ranges) : '',
      tone: 'shift',
      spoken: t ? `${t.name} ${t.ranges.map((r) => `${r.start} to ${r.end}`).join(' and ')}` : 'shift',
    };
  }
  if (action.kind === 'leave') return { ...LEAVE_TILE[action.type], spoken: LEAVE_LABELS[action.type] };
  return { code: '', sub: '', tone: 'empty', spoken: 'empty' };
}

// ---------------------------------------------------------------------------
// Paint batching
// ---------------------------------------------------------------------------

/** How long paint taps are collected before they go to the server as one patch. */
export const PAINT_BATCH_MS = 600;

export interface PendingPaint {
  userId: string;
  date: IsoDate;
  action: CellAction;
}

/** Add a tap to the pending batch; a second tap on the same tile replaces the first (last brush wins). */
export function queuePaint(pending: PendingPaint[], tap: PendingPaint): PendingPaint[] {
  return [...pending.filter((p) => !(p.userId === tap.userId && p.date === tap.date)), tap];
}

/**
 * One patch for a batch of taps, built against the latest week: per tile the
 * ops of `opsForAction`, in tap order, plus the before-snapshots for undo.
 * Tiles that need no change contribute nothing.
 */
export function batchOps(pending: PendingPaint[], dayOf: (userId: string, date: IsoDate) => PersonDay): { ops: WeekPatchOp[]; cells: CellSnapshot[] } {
  const ops: WeekPatchOp[] = [];
  const cells: CellSnapshot[] = [];
  for (const p of pending) {
    const day = dayOf(p.userId, p.date);
    if (day.locked) continue;
    const cellOps = opsForAction(day, p.action);
    if (cellOps.length === 0) continue;
    ops.push(...cellOps);
    cells.push(snapshotOf(day));
  }
  return { ops, cells };
}

/** "Mid · 11:00–20:00 +1" for the confirm sheet. */
export function shiftLine(name: string, ranges: TimeRange[], clock: '12h' | '24h'): string {
  return `${name} · ${ranges.map((r) => formatRange(r, clock)).join(' · ')}${rangesEndNextDay(ranges) ? ' (+1)' : ''}`;
}

/** What a person-day held, for the confirm sheet's "Replaces" line; null when it was empty. */
export function replacesLine(day: PersonDay, week: Pick<WeekDocDto, 'shiftTypes' | 'clock'>): string | null {
  if (day.shifts.length === 0 && !day.leave) return null;
  if (day.shifts.length === 0 && day.leave) return LEAVE_LABELS[day.leave.type];
  return describeDay(day, week.shiftTypes, week.clock);
}

/**
 * The Day view's sections: people by department, plus that day's open
 * shifts filed under their own department — a department with only open
 * shifts (nobody on its team yet) still gets a section.
 */
export function dayGroups(week: Pick<WeekDocDto, 'departments' | 'people' | 'shifts'>, date: IsoDate): { group: DeptGroup; open: WeekShiftDto[] }[] {
  const out = groupPeople(week).map((group) => ({ group, open: [] as WeekShiftDto[] }));
  for (const s of week.shifts) {
    if (s.userId !== null || s.date !== date) continue;
    const id = s.departmentId ?? OTHER_DEPARTMENT;
    let entry = out.find((e) => e.group.id === id);
    if (!entry) {
      const d = week.departments.find((x) => x.id === id);
      entry = { group: { id, name: d?.name ?? 'Other', tint: d?.tint ?? 'cream', people: [] }, open: [] };
      const at = d ? out.findIndex((e) => (week.departments.find((x) => x.id === e.group.id)?.sortOrder ?? Infinity) > d.sortOrder) : -1;
      if (at >= 0) out.splice(at, 0, entry);
      else out.push(entry);
    }
    entry.open.push(s);
  }
  return out;
}

/** The brushes: the venue's live shift types, then the statuses and Erase (B3 paint palette). */
export function brushesOf(week: Pick<WeekDocDto, 'shiftTypes'>): { action: CellAction; name: string; tint: ShiftTint | null }[] {
  return [
    ...week.shiftTypes.filter((t) => !t.archivedAt).map((t) => ({ action: { kind: 'type', shiftTypeId: t.id } as CellAction, name: t.name, tint: t.tint })),
    { action: { kind: 'leave', type: 'DAY_OFF' }, name: 'Day off', tint: null },
    { action: { kind: 'leave', type: 'ANNUAL_LEAVE' }, name: 'Leave', tint: null },
    { action: { kind: 'leave', type: 'SICK_LEAVE' }, name: 'Sick', tint: null },
    { action: { kind: 'erase' }, name: 'Erase', tint: null },
  ];
}
