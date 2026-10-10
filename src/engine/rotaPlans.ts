/**
 * Rota builder v2 — turning a manager's intent into ONE week patch: a drop,
 * a number key, a bulk action, a paste, Copy last week, or a template
 * (Design boards B2, B5; Spec §2). Pure: the grid shows the plan's summary
 * ("Applied to 7 of 8 · 1 on leave skipped") and sends `ops` in one call.
 *
 * Rules mirror the server's week patch (server/src/lib/actions/weekActions.ts):
 * one live shift per person-day; a leave day never also holds a shift
 * (`setLeave` over a shift is refused, so the shift is deleted first); a
 * shift claiming a person-day removes a Day off / Half day — the plans clear
 * it explicitly so undo can put it back; approved leave is never touched.
 */
import {
  weekDays,
  type IsoDate,
  type LeaveTypeCode,
  type TimeRange,
  type WeekDocDto,
  type WeekPatchOp,
  type WeekShiftDto,
} from '../../shared/rotaWeek';
import { cellOf, indexWeek, leaveLocksShifts, type CellContents, type WeekIndex } from './rotaGrid';

export type CellContent =
  | { kind: 'type'; shiftTypeId: string }
  | { kind: 'custom'; shiftTypeId: string | null; ranges: TimeRange[]; note: string | null }
  | { kind: 'leave'; type: LeaveTypeCode }
  | { kind: 'clear' };

export type SkipReason = 'leave' | 'past' | 'request' | 'noRole' | 'inactive' | 'open';

export type PlaceResult = { ops: WeekPatchOp[]; skip?: undefined } | { ops: []; skip: SkipReason };

let tempSeq = 0;
/** Client id echoed back by the server for creates, so a result can be matched to its op. */
export function tempId(): string {
  tempSeq = (tempSeq + 1) % 1_000_000;
  return `tmp-${Date.now().toString(36)}-${tempSeq}`;
}

const sameRanges = (a: TimeRange[], b: TimeRange[]) => a.length === b.length && a.every((r, i) => r.start === b[i]!.start && r.end === b[i]!.end);

/**
 * Ops that put `content` into one PERSON cell. `allowPending` is set after
 * the confirm sheet (a pending request is otherwise a skip: bulk and paste
 * never decline a request silently).
 */
export function placeOps(
  week: WeekDocDto,
  cell: CellContents,
  content: CellContent,
  opts: { today: IsoDate; allowPending?: boolean },
): PlaceResult {
  if (cell.userId === null) return { ops: [], skip: 'open' };
  if (cell.date < opts.today) return { ops: [], skip: 'past' };
  const person = week.people.find((p) => p.id === cell.userId);
  if (!person || !person.isActive) return { ops: [], skip: 'inactive' };
  const shift = cell.shifts[0];
  const leave = cell.leave;
  const userId = person.id;
  const date = cell.date;

  if (content.kind === 'clear') {
    if (leave?.fromRequest) return { ops: [], skip: 'leave' };
    const ops: WeekPatchOp[] = [];
    for (const s of cell.shifts) ops.push({ op: 'delete', shiftId: s.id });
    if (leave) ops.push({ op: 'clearLeave', userId, date });
    return { ops };
  }

  if (content.kind === 'leave') {
    if (leave?.fromRequest) return { ops: [], skip: 'leave' };
    if (leave?.type === content.type && !shift) return { ops: [] };
    const ops: WeekPatchOp[] = [];
    for (const s of cell.shifts) ops.push({ op: 'delete', shiftId: s.id });
    ops.push({ op: 'setLeave', userId, date, type: content.type });
    return { ops };
  }

  // A shift.
  if (leave && leave.fromRequest) return { ops: [], skip: 'leave' };
  if (cell.pendingRequest && !opts.allowPending) return { ops: [], skip: 'request' };
  if (shift) {
    if (content.kind === 'type') {
      if (shift.shiftTypeId === content.shiftTypeId) {
        const t = week.shiftTypes.find((x) => x.id === content.shiftTypeId);
        if (!t || sameRanges(t.ranges, shift.ranges)) return { ops: [] };
      }
      return { ops: [{ op: 'update', shiftId: shift.id, shiftTypeId: content.shiftTypeId }] };
    }
    return { ops: [{ op: 'update', shiftId: shift.id, shiftTypeId: content.shiftTypeId, ranges: content.ranges, note: content.note }] };
  }
  if (!person.roleId) return { ops: [], skip: 'noRole' };
  const ops: WeekPatchOp[] = [];
  // Annual / Sick / Unpaid set by a manager (not from a request) give way too, but the server only removes
  // Day off / Half day on its own — so every leave is cleared explicitly, which also makes the undo exact.
  if (leave) ops.push({ op: 'clearLeave', userId, date });
  ops.push({
    op: 'create',
    tempId: tempId(),
    userId,
    date,
    ...(person.departmentId ? { departmentId: person.departmentId } : {}),
    ...(content.kind === 'type'
      ? { shiftTypeId: content.shiftTypeId }
      : { ...(content.shiftTypeId ? { shiftTypeId: content.shiftTypeId } : {}), ranges: content.ranges, note: content.note }),
  });
  return { ops };
}

/** An open (unassigned) shift of a shift type, filed under a department's role. */
export function openShiftOps(input: {
  date: IsoDate;
  content: Extract<CellContent, { kind: 'type' } | { kind: 'custom' }>;
  roleId: string;
  departmentId: string | null;
}): WeekPatchOp[] {
  const { date, content, roleId, departmentId } = input;
  return [
    {
      op: 'create',
      tempId: tempId(),
      userId: null,
      date,
      roleId,
      departmentId,
      ...(content.kind === 'type'
        ? { shiftTypeId: content.shiftTypeId }
        : { ...(content.shiftTypeId ? { shiftTypeId: content.shiftTypeId } : {}), ranges: content.ranges, note: content.note }),
    },
  ];
}

/** A role to file an open shift under for a department: one of its roles, else a role someone in it holds. */
export function roleForDepartment(week: WeekDocDto, departmentId: string | null): string | null {
  const dept = departmentId ? week.departments.find((d) => d.id === departmentId) : undefined;
  if (dept?.roleIds[0]) return dept.roleIds[0];
  const person = week.people.find((p) => p.isActive && p.roleId && (departmentId === null || p.departmentId === departmentId));
  return person?.roleId ?? week.people.find((p) => p.roleId)?.roleId ?? null;
}

/**
 * Moving (or Alt-copying) a chip onto a cell. The caller has already
 * classified the drop; this only builds the ops: whatever the target
 * person-day holds goes first (its shift is deleted, a leave cleared), then
 * the shift moves — a move to another person files it under their role and
 * department (Spec §4 "Person in two departments": default primary).
 */
export function moveOps(
  week: WeekDocDto,
  idx: WeekIndex,
  shift: WeekShiftDto,
  target: { date: IsoDate; userId: string | null },
  copy: boolean,
): WeekPatchOp[] {
  const ops: WeekPatchOp[] = [];
  const person = target.userId ? week.people.find((p) => p.id === target.userId) : undefined;
  if (target.userId) {
    const cell = cellOf(idx, target.date, target.userId);
    for (const s of cell.shifts) if (s.id !== shift.id) ops.push({ op: 'delete', shiftId: s.id });
    if (cell.leave) ops.push({ op: 'clearLeave', userId: target.userId, date: target.date });
  }
  const people =
    person && target.userId !== shift.userId
      ? {
          ...(person.roleId && person.roleId !== shift.roleId ? { roleId: person.roleId } : {}),
          ...(person.departmentId && person.departmentId !== shift.departmentId ? { departmentId: person.departmentId } : {}),
        }
      : {};
  if (copy) {
    ops.push({
      op: 'create',
      tempId: tempId(),
      userId: target.userId,
      date: target.date,
      roleId: shift.roleId,
      departmentId: shift.departmentId,
      ...(shift.shiftTypeId ? { shiftTypeId: shift.shiftTypeId } : {}),
      ranges: shift.ranges,
      note: shift.note,
      ...people,
    });
  } else {
    ops.push({
      op: 'update',
      shiftId: shift.id,
      ...(target.userId !== shift.userId ? { userId: target.userId } : {}),
      ...(target.date !== shift.date ? { date: target.date } : {}),
      ...people,
    });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Bulk (B5): one action across selected cells, one patch, skips said plainly
// ---------------------------------------------------------------------------

export interface BulkPlan {
  ops: WeekPatchOp[];
  total: number;
  applied: number;
  skipped: Partial<Record<SkipReason, number>>;
}

export function planBulk(week: WeekDocDto, cells: { date: IsoDate; userId: string | null }[], content: CellContent, today: IsoDate): BulkPlan {
  const idx = indexWeek(week);
  const ops: WeekPatchOp[] = [];
  const skipped: BulkPlan['skipped'] = {};
  let applied = 0;
  const seen = new Set<string>();
  for (const c of cells) {
    const key = `${c.date}|${c.userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cell = cellOf(idx, c.date, c.userId);
    if (c.userId === null) {
      // Open row: only Clear makes sense without a department choice.
      if (content.kind === 'clear' && c.date >= today && cell.shifts.length) {
        for (const s of cell.shifts) ops.push({ op: 'delete', shiftId: s.id });
        applied++;
      } else if (content.kind !== 'clear') {
        skipped.open = (skipped.open ?? 0) + 1;
      }
      continue;
    }
    const r = placeOps(week, cell, content, { today });
    if (r.skip) skipped[r.skip] = (skipped[r.skip] ?? 0) + 1;
    else {
      ops.push(...r.ops);
      applied++;
    }
  }
  return { ops, total: seen.size, applied, skipped };
}

const SKIP_WORDS: Record<SkipReason, string> = {
  leave: 'on leave',
  past: 'in the past',
  request: 'with a pending request',
  noRole: 'without a role',
  inactive: 'no longer active',
  open: 'in the open row',
};

/** "Applied to 7 of 8 · 1 on leave skipped" */
export function bulkSummary(plan: Pick<BulkPlan, 'applied' | 'total' | 'skipped'>, verb = 'Applied to'): string {
  const parts = [`${verb} ${plan.applied} of ${plan.total}`];
  for (const [reason, n] of Object.entries(plan.skipped) as [SkipReason, number][]) {
    if (n) parts.push(`${n} ${SKIP_WORDS[reason]} skipped`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Copy / paste cells (⌘C / ⌘V, bulk bar Copy)
// ---------------------------------------------------------------------------

export interface ClipCell {
  rowOffset: number;
  dayOffset: number;
  content: CellContent;
}

/** What a cell holds as pasteable content; approved leave and requests are not copied. */
export function contentOf(cell: CellContents): CellContent {
  const s = cell.shifts[0];
  if (s) return { kind: 'custom', shiftTypeId: s.shiftTypeId, ranges: s.ranges, note: s.note };
  if (cell.leave && !cell.leave.fromRequest) return { kind: 'leave', type: cell.leave.type };
  return { kind: 'clear' };
}

/** Selected person cells → clipboard relative to the top-left selected cell. `rows` is the visible row order (user ids). */
export function copyCells(week: WeekDocDto, cells: { date: IsoDate; userId: string | null }[], rows: string[]): ClipCell[] {
  const idx = indexWeek(week);
  const days = weekDays(week.weekStart);
  const placed = cells
    .filter((c): c is { date: IsoDate; userId: string } => c.userId !== null)
    .map((c) => ({ c, row: rows.indexOf(c.userId), day: days.indexOf(c.date) }))
    .filter((x) => x.row >= 0 && x.day >= 0);
  if (placed.length === 0) return [];
  const top = Math.min(...placed.map((x) => x.row));
  const left = Math.min(...placed.map((x) => x.day));
  return placed.map((x) => ({ rowOffset: x.row - top, dayOffset: x.day - left, content: contentOf(cellOf(idx, x.c.date, x.c.userId)) }));
}

export function planPaste(week: WeekDocDto, clip: ClipCell[], anchor: { row: number; day: number }, rows: string[], today: IsoDate): BulkPlan {
  const days = weekDays(week.weekStart);
  const idx = indexWeek(week);
  const ops: WeekPatchOp[] = [];
  const skipped: BulkPlan['skipped'] = {};
  let applied = 0;
  let total = 0;
  for (const c of clip) {
    const userId = rows[anchor.row + c.rowOffset];
    const date = days[anchor.day + c.dayOffset];
    if (!userId || !date) continue;
    total++;
    const r = placeOps(week, cellOf(idx, date, userId), c.content, { today });
    if (r.skip) skipped[r.skip] = (skipped[r.skip] ?? 0) + 1;
    else {
      ops.push(...r.ops);
      applied++;
    }
  }
  return { ops, total, applied, skipped };
}

// ---------------------------------------------------------------------------
// Copy last week and templates (B5): weekday → weekday, never date → date
// ---------------------------------------------------------------------------

export interface PlanEntry {
  dayOffset: number;
  userId: string | null;
  roleId: string | null;
  departmentId: string | null;
  shiftTypeId: string | null;
  ranges: TimeRange[];
  note: string | null;
}

export interface CopyAttention {
  userId: string;
  reason: 'leave' | 'inactive' | 'requested';
  dates: IsoDate[];
  /** How many of their shifts became open shifts (or were dropped, for a template). */
  count: number;
}

export interface CopyPlan {
  ops: WeekPatchOp[];
  /** Shifts the patch creates (assigned + open). */
  created: number;
  /** People with at least one copied shift. */
  people: number;
  /** Shifts that became open shifts because their person can't take them. */
  attention: CopyAttention[];
  /** Fill mode: target cells that already had something, kept. */
  keptExisting: number;
  /** Replace mode: shifts already in the target week that the copy deletes. */
  overwritten: number;
  skippedPast: number;
  /** Day-off statuses copied. */
  dayOffs: number;
  /** Shifts that could not be placed at all (no role to file an open shift under, or a person who left, for a template). */
  dropped: number;
}

export interface CopyPlanInput {
  target: WeekDocDto;
  entries: PlanEntry[];
  /** Day-off statuses to copy (manager-set Day off only). */
  dayOffs?: { dayOffset: number; userId: string }[];
  mode: 'fill' | 'replace';
  today: IsoDate;
  /** Only this department (templates: "Floor only"). */
  departmentId?: string | null;
  /** Copy turns a missing person's shift into an open shift; a template drops it (B5). */
  missingPerson: 'open' | 'drop';
}

/** How many shifts a full replace would delete (shown before the manager picks the mode). */
export function replaceableCount(target: WeekDocDto, today: IsoDate, departmentId?: string | null): number {
  return target.shifts.filter((s) => s.date >= today && inDepartment(target, s.userId, s.departmentId, departmentId)).length;
}

function inDepartment(week: WeekDocDto, userId: string | null, shiftDept: string | null, filter: string | null | undefined): boolean {
  if (!filter) return true;
  if (shiftDept === filter) return true;
  const p = userId ? week.people.find((x) => x.id === userId) : undefined;
  return !!p && (p.departmentId === filter || p.alsoDepartmentIds.includes(filter));
}

export function planCopy(input: CopyPlanInput): CopyPlan {
  const { target, entries, mode, today, departmentId, missingPerson } = input;
  const days = weekDays(target.weekStart);
  const idx = indexWeek(target);
  const deletes: WeekPatchOp[] = [];
  const clears: WeekPatchOp[] = [];
  const creates: WeekPatchOp[] = [];
  const leaves: WeekPatchOp[] = [];
  const deleted = new Set<string>();
  const claimed = new Set<string>();
  const people = new Set<string>();
  const attention = new Map<string, CopyAttention>();
  let keptExisting = 0;
  let skippedPast = 0;
  let dropped = 0;
  let dayOffs = 0;

  if (mode === 'replace') {
    for (const s of target.shifts) {
      if (s.date < today || !inDepartment(target, s.userId, s.departmentId, departmentId)) continue;
      deletes.push({ op: 'delete', shiftId: s.id });
      deleted.add(s.id);
    }
  }
  const liveShift = (cell: CellContents) => cell.shifts.find((s) => !deleted.has(s.id));
  const flag = (userId: string, reason: CopyAttention['reason'], date: IsoDate) => {
    const key = `${userId}|${reason}`;
    const a = attention.get(key) ?? { userId, reason, dates: [], count: 0 };
    if (!a.dates.includes(date)) a.dates.push(date);
    a.count++;
    attention.set(key, a);
  };
  const timing = (e: PlanEntry) => {
    const type = e.shiftTypeId ? target.shiftTypes.find((t) => t.id === e.shiftTypeId && !t.archivedAt) : undefined;
    return { ...(type ? { shiftTypeId: type.id } : {}), ranges: e.ranges.map((r) => ({ start: r.start, end: r.end })), note: e.note };
  };
  const openCreate = (e: PlanEntry, date: IsoDate, roleId: string | null, departmentIdOf: string | null): boolean => {
    if (!roleId) return false;
    creates.push({ op: 'create', tempId: tempId(), userId: null, date, roleId, departmentId: departmentIdOf, ...timing(e) });
    return true;
  };

  for (const e of entries) {
    const date = days[e.dayOffset];
    if (!date) continue;
    if (!inDepartment(target, e.userId, e.departmentId, departmentId)) continue;
    if (date < today) {
      skippedPast++;
      continue;
    }
    if (e.userId === null) {
      if (openCreate(e, date, e.roleId, e.departmentId)) {
        // Open shifts never collide: any number per day.
      } else dropped++;
      continue;
    }
    const person = target.people.find((p) => p.id === e.userId);
    if (!person || !person.isActive) {
      if (missingPerson === 'drop') {
        dropped++;
        continue;
      }
      if (openCreate(e, date, e.roleId ?? person?.roleId ?? null, e.departmentId ?? person?.departmentId ?? null)) flag(e.userId, 'inactive', date);
      else dropped++;
      continue;
    }
    const cell = cellOf(idx, date, e.userId);
    const key = `${date}|${e.userId}`;
    if (claimed.has(key)) continue;
    if (cell.leave && leaveLocksShifts(cell.leave)) {
      if (openCreate(e, date, e.roleId ?? person.roleId, e.departmentId ?? person.departmentId)) flag(e.userId, 'leave', date);
      else dropped++;
      continue;
    }
    if (cell.pendingRequest) {
      if (openCreate(e, date, e.roleId ?? person.roleId, e.departmentId ?? person.departmentId)) flag(e.userId, 'requested', date);
      else dropped++;
      continue;
    }
    if (liveShift(cell) || (cell.leave && mode === 'fill')) {
      keptExisting++;
      continue;
    }
    const roleId = e.roleId ?? person.roleId;
    if (!roleId) {
      dropped++;
      continue;
    }
    if (cell.leave) clears.push({ op: 'clearLeave', userId: e.userId, date });
    creates.push({
      op: 'create',
      tempId: tempId(),
      userId: e.userId,
      date,
      roleId,
      departmentId: e.departmentId ?? person.departmentId,
      ...timing(e),
    });
    claimed.add(key);
    people.add(e.userId);
  }

  for (const d of input.dayOffs ?? []) {
    const date = days[d.dayOffset];
    if (!date || date < today) continue;
    const person = target.people.find((p) => p.id === d.userId);
    if (!person || !person.isActive) continue;
    if (departmentId && !inDepartment(target, d.userId, null, departmentId)) continue;
    const key = `${date}|${d.userId}`;
    if (claimed.has(key)) continue;
    const cell = cellOf(idx, date, d.userId);
    if (liveShift(cell) || cell.leave || cell.pendingRequest) continue;
    leaves.push({ op: 'setLeave', userId: d.userId, date, type: 'DAY_OFF' });
    claimed.add(key);
    dayOffs++;
  }

  return {
    ops: [...deletes, ...clears, ...creates, ...leaves],
    created: creates.length,
    people: people.size,
    attention: [...attention.values()],
    keptExisting,
    overwritten: deletes.length,
    skippedPast,
    dayOffs,
    dropped,
  };
}

/** A week's shifts as weekday-relative entries (Copy last week). */
export function entriesOfWeek(source: WeekDocDto): PlanEntry[] {
  const days = weekDays(source.weekStart);
  return source.shifts
    .map((s) => ({
      dayOffset: days.indexOf(s.date),
      userId: s.userId,
      roleId: s.roleId || null,
      departmentId: s.departmentId,
      shiftTypeId: s.shiftTypeId,
      ranges: s.ranges,
      note: s.note,
    }))
    .filter((e) => e.dayOffset >= 0);
}

/** Manager-set Day off statuses of a week, weekday-relative. Leave from approved requests is never copied. */
export function dayOffsOfWeek(source: WeekDocDto): { dayOffset: number; userId: string }[] {
  const days = weekDays(source.weekStart);
  return source.leaves
    .filter((l) => l.type === 'DAY_OFF' && !l.fromRequest)
    .map((l) => ({ dayOffset: days.indexOf(l.date), userId: l.userId }))
    .filter((x) => x.dayOffset >= 0);
}
