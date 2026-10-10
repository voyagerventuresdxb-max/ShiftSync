/**
 * Rota builder v2 — undo / redo as inverse patch batches (Spec §2 "Undo /
 * redo semantics"). Every grid action is ONE week patch; its inverse is
 * computed from the week as it was before the patch plus the server's
 * per-op results (the ids of shifts it created), and is itself applied as
 * ONE patch. Recreating a deleted shift gives it a new id, so the history
 * keeps an alias map (old id → new id) that older entries are resolved
 * through before they are sent.
 */
import type { IsoDate, LeaveTypeCode, TimeRange, WeekDocDto, WeekPatchOp, WeekShiftDto } from '../../shared/rotaWeek';

type ShiftState = Pick<WeekShiftDto, 'id' | 'userId' | 'roleId' | 'departmentId' | 'shiftTypeId' | 'date' | 'ranges' | 'note'>;

interface Sim {
  shifts: Map<string, ShiftState>;
  /** `${userId}|${date}` → type */
  leaves: Map<string, LeaveTypeCode>;
}

const leaveKey = (userId: string, date: IsoDate) => `${userId}|${date}`;

function simOf(week: Pick<WeekDocDto, 'shifts' | 'leaves'>): Sim {
  return {
    shifts: new Map(week.shifts.map((s) => [s.id, { id: s.id, userId: s.userId, roleId: s.roleId, departmentId: s.departmentId, shiftTypeId: s.shiftTypeId, date: s.date, ranges: s.ranges, note: s.note }])),
    leaves: new Map(week.leaves.map((l) => [leaveKey(l.userId, l.date), l.type])),
  };
}

/** The ops that put back a shift exactly as it was (type label + frozen times + note + people fields). */
function restoreFields(prev: ShiftState): Omit<Extract<WeekPatchOp, { op: 'update' }>, 'op' | 'shiftId'> {
  return {
    userId: prev.userId,
    date: prev.date,
    roleId: prev.roleId,
    departmentId: prev.departmentId,
    shiftTypeId: prev.shiftTypeId,
    ranges: prev.ranges.map((r): TimeRange => ({ start: r.start, end: r.end })),
    note: prev.note,
  };
}

/**
 * The batch that undoes `ops` (as applied, with `results`) on `before`.
 *
 * Per op, in reverse order:
 * - create → delete the new shift (+ put back a Day off / Half day the server removed to make room);
 * - update → update back to every previous field (+ the same leave rule for the cell it moved into);
 * - delete → create it again, `tempId` = the old id so the alias map can follow it;
 * - setLeave / clearLeave → the previous leave, or none.
 *
 * Requests declined by `overridePendingRequests` cannot be reopened by a patch;
 * the caller says so in the undo toast.
 */
export function invertOps(
  before: Pick<WeekDocDto, 'shifts' | 'leaves'>,
  ops: WeekPatchOp[],
  results: { op: number; shiftId?: string }[],
): WeekPatchOp[] {
  const sim = simOf(before);
  const inverses: WeekPatchOp[][] = [];
  const giveWay = (userId: string | null, date: IsoDate, out: WeekPatchOp[]) => {
    // The server removes a Day off / Half day when a shift claims the person-day (weekActions.claimPersonDay).
    if (!userId) return;
    const k = leaveKey(userId, date);
    const prev = sim.leaves.get(k);
    if (prev) {
      out.push({ op: 'setLeave', userId, date, type: prev });
      sim.leaves.delete(k);
    }
  };
  ops.forEach((op, i) => {
    const inv: WeekPatchOp[] = [];
    switch (op.op) {
      case 'create': {
        const id = results.find((r) => r.op === i)?.shiftId;
        if (!id) break;
        inv.push({ op: 'delete', shiftId: id });
        giveWay(op.userId, op.date, inv);
        sim.shifts.set(id, {
          id,
          userId: op.userId,
          roleId: op.roleId ?? '',
          departmentId: op.departmentId ?? null,
          shiftTypeId: op.shiftTypeId ?? null,
          date: op.date,
          ranges: op.ranges ?? [],
          note: op.note ?? null,
        });
        break;
      }
      case 'update': {
        const prev = sim.shifts.get(op.shiftId);
        if (!prev) break;
        const next: ShiftState = {
          ...prev,
          ...(op.userId !== undefined ? { userId: op.userId } : {}),
          ...(op.date !== undefined ? { date: op.date } : {}),
          ...(op.roleId !== undefined ? { roleId: op.roleId } : {}),
          ...(op.departmentId !== undefined ? { departmentId: op.departmentId } : {}),
          ...(op.shiftTypeId !== undefined ? { shiftTypeId: op.shiftTypeId } : {}),
          ...(op.ranges !== undefined ? { ranges: op.ranges } : {}),
          ...(op.note !== undefined ? { note: op.note } : {}),
        };
        inv.push({ op: 'update', shiftId: op.shiftId, ...restoreFields(prev) });
        if (next.userId !== prev.userId || next.date !== prev.date) giveWay(next.userId, next.date, inv);
        sim.shifts.set(op.shiftId, next);
        break;
      }
      case 'delete': {
        const prev = sim.shifts.get(op.shiftId);
        if (!prev) break;
        const f = restoreFields(prev);
        inv.push({
          op: 'create',
          tempId: prev.id,
          userId: prev.userId,
          ...(prev.roleId ? { roleId: prev.roleId } : {}),
          departmentId: f.departmentId,
          date: prev.date,
          ...(prev.shiftTypeId ? { shiftTypeId: prev.shiftTypeId } : {}),
          ranges: f.ranges,
          note: prev.note,
        });
        sim.shifts.delete(op.shiftId);
        break;
      }
      case 'setLeave': {
        const k = leaveKey(op.userId, op.date);
        const prev = sim.leaves.get(k);
        inv.push(prev ? { op: 'setLeave', userId: op.userId, date: op.date, type: prev } : { op: 'clearLeave', userId: op.userId, date: op.date });
        sim.leaves.set(k, op.type);
        break;
      }
      case 'clearLeave': {
        const k = leaveKey(op.userId, op.date);
        const prev = sim.leaves.get(k);
        if (prev) inv.push({ op: 'setLeave', userId: op.userId, date: op.date, type: prev });
        sim.leaves.delete(k);
        break;
      }
    }
    inverses.push(inv);
  });
  return inverses.reverse().flat();
}

/** old id → new id for every create in `ops` that recreated a shift (its `tempId` is the old id). */
export function aliasesFrom(ops: WeekPatchOp[], results: { op: number; tempId?: string; shiftId?: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  ops.forEach((op, i) => {
    if (op.op !== 'create' || !op.tempId) return;
    const r = results.find((x) => x.op === i);
    if (r?.shiftId && r.shiftId !== op.tempId) out[op.tempId] = r.shiftId;
  });
  return out;
}

export function resolveId(id: string, alias: Record<string, string>): string {
  let cur = id;
  // Bounded walk: an alias chain grows by one per undo/redo of a delete, and the history is capped at 100.
  for (let i = 0; i < 256 && Object.hasOwn(alias, cur); i++) cur = alias[cur]!;
  return cur;
}

/** `ops` with every shift id followed through the alias map. */
export function remapOps(ops: WeekPatchOp[], alias: Record<string, string>): WeekPatchOp[] {
  return ops.map((op) => (op.op === 'update' || op.op === 'delete' ? { ...op, shiftId: resolveId(op.shiftId, alias) } : op));
}

// ---------------------------------------------------------------------------
// History: one stack per week document, capped, cleared on week change / publish
// ---------------------------------------------------------------------------

export const HISTORY_CAP = 100;

export interface HistoryEntry {
  /** "Moved Omar → Thu 8", "Copied last week (34)" */
  label: string;
  /** The batch that reverses this entry when applied. */
  ops: WeekPatchOp[];
}

export interface History {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  alias: Record<string, string>;
}

export function emptyHistory(): History {
  return { undo: [], redo: [], alias: {} };
}

const capped = (list: HistoryEntry[]) => (list.length > HISTORY_CAP ? list.slice(list.length - HISTORY_CAP) : list);

/** A new user action: its inverse goes on the undo stack and redo is invalidated. Empty inverses are not recorded. */
export function recordAction(h: History, entry: HistoryEntry): History {
  if (entry.ops.length === 0) return { ...h, redo: [] };
  return { ...h, undo: capped([...h.undo, entry]), redo: [] };
}

/** After the top undo entry was applied: `redoEntry` (the inverse of what was just applied) goes on the redo stack. */
export function afterUndo(h: History, redoEntry: HistoryEntry, alias: Record<string, string> = {}): History {
  return { undo: h.undo.slice(0, -1), redo: capped([...h.redo, redoEntry]), alias: { ...h.alias, ...alias } };
}

/** After the top redo entry was applied: `undoEntry` goes back on the undo stack. */
export function afterRedo(h: History, undoEntry: HistoryEntry, alias: Record<string, string> = {}): History {
  return { undo: capped([...h.undo, undoEntry]), redo: h.redo.slice(0, -1), alias: { ...h.alias, ...alias } };
}
