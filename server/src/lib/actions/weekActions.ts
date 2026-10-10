import { createHash } from 'node:crypto';
import type { Prisma, ShiftStatus } from '@prisma/client';
import { prisma } from '../prisma.js';
import { writeAuditLog, withAuditedTransaction } from '../auditLog.js';
import { notifyUser } from '../push.js';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from '../../parsing/normalize.js';
import { formatVenueTime } from '../venueTime.js';
import { calendarWeekRange, isMondayIso, WEEK_START_NOT_MONDAY_ERROR } from '../venueWeek.js';
import { findActiveVenueRole, findOverlappingShift, findVenueUser, isPastVenueDay, isRealDate } from '../shiftRules.js';
import {
  LEAVE_LABELS,
  formatRange,
  initialsOf,
  leaveBlocksShifts,
  rangesEndNextDay,
  validateRanges,
  weekDays,
  type CoverageDayDto,
  type DepartmentDto,
  type IsoDate,
  type LeaveTypeCode,
  type PublishDiffRow,
  type PublishPreviewDto,
  type PublishResult,
  type ShiftTint,
  type ShiftTypeDto,
  type TimeRange,
  type WeekDocDto,
  type WeekLeaveDto,
  type WeekPatchInput,
  type WeekPatchOp,
  type WeekPatchRefusal,
  type WeekPatchResult,
  type WeekPersonDto,
  type WeekRequestDto,
  type WeekShiftDto,
} from '../../../../shared/rotaWeek.js';

/**
 * Rota builder v2 — the week document (shared/rotaWeek.ts) as server actions.
 *
 * One source of truth for the roster: `shifts` + `rota_leaves`, versioned per
 * (venue, Monday) by `rota_weeks.version`. EVERY roster write — the grid, the
 * legacy single-shift routes, voice, templates, swap approvals, the roster
 * import — goes through `applyWeekPatch` (or `applyWeekPatchIn` inside its
 * own transaction), so the version bump, the one-live-shift-per-person-day
 * rule, leave/pending-request checks, section-assignment cleanup and the
 * audit trail can never drift between entry points. Reads go through
 * `getWeekDoc`; publishing through `previewWeekPublish` + `publishWeek`.
 *
 * Concurrency: a per-week Postgres advisory lock (`lockWeek`) serialises every
 * writer of one week inside its transaction, and the conditional
 * `updateMany ... WHERE version = <seen>` (swapActions.ts's idiom) is the
 * belt to that brace — a writer that somehow bypassed the lock still cannot
 * bump a version it did not see.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type WeekViewer = { role: 'OWNER' | 'MANAGER' | 'STAFF' | 'KIOSK'; userId?: string };
export type WeekPatchSource = 'grid' | 'voice' | 'template' | 'import' | 'swap' | 'timeOff' | 'bulk';

export interface ApplyWeekPatchInput {
  locationId: string;
  weekStart: IsoDate;
  /** Who is recorded in the audit trail; null only for system-initiated writes. */
  actorId: string | null;
  source: WeekPatchSource;
  patch: WeekPatchInput;
  /** Whose view the returned week document is rendered for (default: a manager). */
  viewer?: WeekViewer;
}

export type WeekPatchOk = Extract<WeekPatchResult, { result: 'ok' }>;

const MANAGER_VIEWER: WeekViewer = { role: 'MANAGER' };
const NOTE_MAX = 80;
/** A device counts as "registered" when the person has a push subscription or signed in within this window. */
const DEVICE_WINDOW_DAYS = 30;
const URGENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Prisma interactive-transaction limits for a patch: a template apply or an import touches a few hundred rows. */
const PATCH_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** Roles with no department are grouped under this synthetic department in the week document. */
export const OTHER_DEPARTMENT_ID = 'other';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The patch presented a version the week has moved past. Thrown inside the transaction so nothing of it lands. */
export class WeekVersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super(`The week is at version ${currentVersion}.`);
    this.name = 'WeekVersionConflictError';
  }
}

/**
 * One op of the batch failed a rule. Thrown (rather than returned) so a refusal
 * on op 3 rolls back ops 1–2 too — a patch is all-or-nothing. `op` is -1 for a
 * batch-level refusal (`not_monday`).
 */
export class WeekPatchRefusedError extends Error {
  constructor(
    public readonly refusal: WeekPatchRefusal,
    public readonly op: number,
    message: string,
  ) {
    super(message);
    this.name = 'WeekPatchRefusedError';
  }
}

export class UnknownLocationError extends Error {
  constructor(locationId: string) {
    super(`Location "${locationId}" not found.`);
    this.name = 'UnknownLocationError';
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toIso = (d: Date): IsoDate => d.toISOString().slice(0, 10);
const dateAt = (iso: IsoDate): Date => new Date(`${iso}T00:00:00.000Z`);
const refuse = (refusal: WeekPatchRefusal, op: number, message: string) => new WeekPatchRefusedError(refusal, op, message);

const TINTS: readonly string[] = ['gold', 'sand', 'clay', 'ochre', 'sage', 'cream'];
/** A stored tint that is not a known token renders as the neutral chip rather than breaking the palette gate. */
const asTint = (tint: string): ShiftTint => (TINTS.includes(tint) ? (tint as ShiftTint) : 'cream');

/** `week:<venue>:<Monday>` — the advisory-lock key every writer of one week takes. */
export async function lockWeek(tx: Prisma.TransactionClient, locationId: string, weekStart: IsoDate): Promise<void> {
  const key = `week:${locationId}:${weekStart}`;
  // Same idiom as parsing/persistShifts.ts's roster-import lock. Transaction-scoped and
  // re-entrant within one transaction, so a caller that already holds it (swapActions)
  // can call applyWeekPatchIn without deadlocking itself.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
}

async function venueTimezoneIn(db: Db, locationId: string): Promise<string> {
  const location = await db.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  if (!location) throw new UnknownLocationError(locationId);
  return location.timezone || DEFAULT_VENUE_TIMEZONE;
}

/**
 * A shift's frozen ranges. A pre-v2 row (null `ranges`) is read back from its
 * own start/end instants as venue wall-clock, which is exactly what the
 * migration's backfill would have written for it.
 */
export function shiftRangesOf(
  s: { ranges: Prisma.JsonValue | null; endsNextDay: boolean; startTime: Date; endTime: Date },
  tz: string,
): { ranges: TimeRange[]; endsNextDay: boolean } {
  if (validateRanges(s.ranges)) {
    return { ranges: s.ranges.map((r) => ({ start: r.start, end: r.end })), endsNextDay: s.endsNextDay };
  }
  const start = formatVenueTime(s.startTime, tz);
  const end = formatVenueTime(s.endTime, tz);
  return { ranges: [{ start, end }], endsNextDay: end <= start };
}

/**
 * The start/end instants legacy readers (attendance, kiosk, voice reads,
 * routes/shifts.ts's DTO) keep working from: the FIRST range's start and the
 * LAST range's end, the latter on the next venue day when the shift crosses
 * midnight. A split shift's instants therefore span its break.
 */
export function shiftInstantsOf(date: IsoDate, ranges: TimeRange[], tz: string): { startTime: Date; endTime: Date } {
  const first = ranges[0]!;
  const last = ranges[ranges.length - 1]!;
  return {
    startTime: combineDateAndTime(date, first.start, tz),
    endTime: combineDateAndTime(date, last.end, tz, rangesEndNextDay(ranges)),
  };
}

/**
 * Who can be reached by an in-app notice: anyone with a Web Push subscription,
 * or who signed in within the last 30 days (a session means the app is on a
 * device and the notification bell will show it). One definition, used by the
 * week document's `hasDevice` and the publish preview's `notifiedCount`.
 */
async function deviceHolders(db: Db, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const since = new Date(Date.now() - DEVICE_WINDOW_DAYS * 86_400_000);
  const subs = await db.pushSubscription.findMany({ where: { userId: { in: userIds } }, select: { userId: true }, distinct: ['userId'] });
  const sessions = await db.session.findMany({ where: { userId: { in: userIds }, createdAt: { gte: since } }, select: { userId: true }, distinct: ['userId'] });
  return new Set([...subs.map((s) => s.userId), ...sessions.map((s) => s.userId)]);
}

/**
 * What staff of a week with no `rota_weeks` row were already told: a week
 * published before v2 (a legacy RotaPublish row, or PUBLISHED rows the old
 * roster import wrote without one). Null when nothing of the week was ever
 * published. Used to seed the row's snapshot when it is first created, and
 * by the publish preview / staff view of a week that has no row yet, so all
 * three agree on what "unchanged since publish" means.
 */
async function legacyToldSnapshot(
  db: Db,
  locationId: string,
  weekStart: IsoDate,
  tz: string,
): Promise<{ snapshot: WeekSnapshot; publishedAt: Date | null; publishedById: string | null } | null> {
  const legacy = await db.rotaPublish.findUnique({ where: { locationId_weekStart: { locationId, weekStart: dateAt(weekStart) } } });
  const snapshot = await buildSnapshot(db, locationId, weekStart, tz, { publishedOnly: true });
  if (!legacy && Object.keys(snapshot.shifts).length === 0 && Object.keys(snapshot.leaves).length === 0) return null;
  return { snapshot, publishedAt: legacy?.publishedAt ?? null, publishedById: legacy?.publishedById ?? null };
}

/**
 * The week row, created lazily by the first writer (version 1). A week that
 * was published before it had a row starts PUBLISHED at version 1 with what
 * staff were told as its snapshot — otherwise the first v2 publish would
 * treat every existing shift as new and notify everyone.
 */
async function findOrCreateWeekRow(tx: Prisma.TransactionClient, locationId: string, weekStart: IsoDate, tz: string) {
  const where = { locationId_weekStart: { locationId, weekStart: dateAt(weekStart) } };
  const existing = await tx.rotaWeek.findUnique({ where });
  if (existing) return existing;
  const told = await legacyToldSnapshot(tx, locationId, weekStart, tz);
  if (!told) return tx.rotaWeek.create({ data: { locationId, weekStart: dateAt(weekStart) } });
  return tx.rotaWeek.create({
    data: {
      locationId,
      weekStart: dateAt(weekStart),
      state: 'PUBLISHED',
      publishedVersion: 1,
      publishedAt: told.publishedAt ?? new Date(),
      publishedById: told.publishedById,
      publishedSnapshot: told.snapshot as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * The version of one shift row that staff currently see: what the last
 * publish told them (`publishedSnapshot`), not the manager's edits since —
 * the design's rule that staff surfaces keep showing the published value
 * until Publish (board E, "what in sync means"). A draft is never visible; a
 * soft-cancelled (CANCELLED) or edited published shift shows its told
 * version until the next publish. A published row the snapshot does not list
 * (or a week with no snapshot at all) is shown as it stands.
 */
export function toldShiftOf(
  row: {
    id: string;
    userId: string | null;
    date: Date;
    startTime: Date;
    endTime: Date;
    ranges: Prisma.JsonValue | null;
    endsNextDay: boolean;
    shiftTypeId: string | null;
    note: string | null;
    status: ShiftStatus;
    editedSincePublish: boolean;
  },
  snapshot: WeekSnapshot | null,
  tz: string,
): { userId: string | null; date: IsoDate; ranges: TimeRange[]; endsNextDay: boolean; shiftTypeId: string | null; note: string | null } | null {
  if (row.status === 'DRAFT') return null;
  const told = snapshot?.shifts[row.id];
  if (told && validateRanges(told.ranges)) {
    return {
      userId: told.userId ?? null,
      date: told.date,
      ranges: told.ranges.map((r) => ({ start: r.start, end: r.end })),
      endsNextDay: rangesEndNextDay(told.ranges),
      shiftTypeId: told.shiftTypeId ?? null,
      note: told.note ?? null,
    };
  }
  if (row.status === 'CANCELLED' || (snapshot && row.editedSincePublish)) return null;
  const timing = shiftRangesOf(row, tz);
  return { userId: row.userId, date: toIso(row.date), ranges: timing.ranges, endsNextDay: timing.endsNextDay, shiftTypeId: row.shiftTypeId, note: row.note };
}

/** The told snapshot of one week as staff surfaces should read it (see `toldShiftOf`). */
export async function toldSnapshotOf(db: Db, locationId: string, weekStart: IsoDate, tz: string): Promise<WeekSnapshot | null> {
  const row = await db.rotaWeek.findUnique({ where: { locationId_weekStart: { locationId, weekStart: dateAt(weekStart) } }, select: { publishedSnapshot: true } });
  if (row) return readSnapshot(row.publishedSnapshot);
  return (await legacyToldSnapshot(db, locationId, weekStart, tz))?.snapshot ?? null;
}

// ---------------------------------------------------------------------------
// Read: the week document
// ---------------------------------------------------------------------------

type ShiftRow = {
  id: string;
  userId: string | null;
  roleId: string;
  departmentId: string | null;
  shiftTypeId: string | null;
  date: Date;
  startTime: Date;
  endTime: Date;
  ranges: Prisma.JsonValue | null;
  endsNextDay: boolean;
  note: string | null;
  status: ShiftStatus;
  editedSincePublish: boolean;
  role: { departmentId: string | null };
};

const SHIFT_ROW_SELECT = {
  id: true,
  userId: true,
  roleId: true,
  departmentId: true,
  shiftTypeId: true,
  date: true,
  startTime: true,
  endTime: true,
  ranges: true,
  endsNextDay: true,
  note: true,
  status: true,
  editedSincePublish: true,
  role: { select: { departmentId: true } },
} as const;

/**
 * Assembles the WeekDocDto for one venue-week as `viewer` may see it: a
 * STAFF or KIOSK viewer gets the week as it was last published — each
 * shift and leave as staff were told it (`toldShiftOf`; drafts, edits and
 * removals since publish stay invisible until the next publish), only their
 * own requests and pending-request markers (kiosk: none), and no
 * unpublished-changes flag; a manager gets the live rows, drafts included,
 * never CANCELLED rows (those are pending removals the publish diff reports).
 */
export async function getWeekDoc(input: { locationId: string; weekStart: IsoDate; viewer: WeekViewer }, db: Db = prisma): Promise<WeekDocDto> {
  const { locationId, weekStart, viewer } = input;
  if (!isMondayIso(weekStart)) throw new Error(WEEK_START_NOT_MONDAY_ERROR);
  const tz = await venueTimezoneIn(db, locationId);
  const { start, end } = calendarWeekRange(weekStart);
  const days = weekDays(weekStart);
  const staffView = viewer.role === 'STAFF' || viewer.role === 'KIOSK';

  // Sequential, not Promise.all: `db` may be a transaction client bound to one connection.
  const weekRow = await db.rotaWeek.findUnique({ where: { locationId_weekStart: { locationId, weekStart: start } } });
  // A week with no row yet: whatever was published before v2 is what staff were told.
  const legacyTold = weekRow ? null : await legacyToldSnapshot(db, locationId, weekStart, tz);
  const snapshot = weekRow ? readSnapshot(weekRow.publishedSnapshot) : (legacyTold?.snapshot ?? null);
  const departmentRows = await db.department.findMany({ where: { locationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  const roleRows = await db.role.findMany({ where: { locationId }, select: { id: true, name: true, departmentId: true, isActive: true }, orderBy: { name: 'asc' } });
  const shiftTypeRows = await db.shiftType.findMany({ where: { locationId } });
  const userRows = await db.user.findMany({
    where: { locationId, isActive: true, deletedAt: null },
    select: { id: true, fullName: true, roleId: true, role: { select: { name: true, departmentId: true } } },
    orderBy: { fullName: 'asc' },
  });
  const shiftRows: ShiftRow[] = await db.shift.findMany({
    where: {
      locationId,
      date: { gte: start, lt: end },
      // Staff need CANCELLED rows too: a removal they have not been told about yet still shows its told version.
      status: staffView ? { in: ['PUBLISHED', 'COMPLETED', 'CANCELLED'] } : { not: 'CANCELLED' },
    },
    select: SHIFT_ROW_SELECT,
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });
  const leaveRows = await db.rotaLeave.findMany({
    where: { locationId, date: { gte: start, lt: end } },
    orderBy: [{ date: 'asc' }],
  });
  const pendingTimeOff = await db.timeOffRequest.findMany({
    where: { status: 'PENDING', user: { locationId }, startDate: { lt: end }, endDate: { gte: start } },
    select: { id: true, userId: true, startDate: true, endDate: true, reason: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const pendingSwaps =
    viewer.role === 'KIOSK'
      ? []
      : await db.shiftSwapRequest.findMany({
          where: { status: 'PENDING', shift: { locationId, date: { gte: start, lt: end } } },
          select: { id: true, shiftId: true, requestedById: true, targetUserId: true, reason: true, createdAt: true, shift: { select: { date: true } } },
          orderBy: { createdAt: 'asc' },
        });
  const minimums = await db.departmentMinimum.findMany({ where: { locationId } });
  const devices = await deviceHolders(db, userRows.map((u) => u.id));

  // Departments: real ones first, then "Other" for roles nobody has grouped yet.
  const roleDept = new Map(roleRows.map((r) => [r.id, r.departmentId]));
  const departments: DepartmentDto[] = departmentRows.map((d): DepartmentDto => ({
    id: d.id,
    name: d.name,
    tint: asTint(d.tint),
    sortOrder: d.sortOrder,
    roleIds: roleRows.filter((r) => r.departmentId === d.id).map((r) => r.id),
  }));
  const ungrouped = roleRows.filter((r) => !r.departmentId).map((r) => r.id);
  if (ungrouped.length > 0) {
    departments.push({ id: OTHER_DEPARTMENT_ID, name: 'Other', tint: 'cream', sortOrder: departments.length, roleIds: ungrouped });
  }

  // Shift types: live ones first (by sortOrder, then name), archived after, so a chip row never leads with a retired timing.
  const shiftTypes: ShiftTypeDto[] = shiftTypeRows
    .slice()
    .sort((a, b) => {
      const archived = Number(a.archivedAt !== null) - Number(b.archivedAt !== null);
      return archived || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    })
    .map((t): ShiftTypeDto => {
      const ranges = validateRanges(t.ranges) ? t.ranges.map((r) => ({ start: r.start, end: r.end })) : [];
      return { id: t.id, name: t.name, ranges, endsNextDay: t.endsNextDay, tint: asTint(t.tint), sortOrder: t.sortOrder, archivedAt: t.archivedAt?.toISOString() ?? null };
    });

  // Shifts. A shift's department is its own, else its role's; null when neither has one (the client files it under "Other").
  // A staff or kiosk viewer gets each shift as they were last told it (`toldShiftOf`): drafts and unpublished edits
  // never reach them, and a request id only when it is the viewer's own.
  const pendingFor = (userId: string | null, date: IsoDate) =>
    userId ? pendingTimeOff.find((r) => r.userId === userId && toIso(r.startDate) <= date && date <= toIso(r.endDate)) : undefined;
  const shifts: WeekShiftDto[] = [];
  for (const s of shiftRows) {
    if (staffView) {
      const told = toldShiftOf(s, snapshot, tz);
      if (!told) continue;
      const ownRequest = viewer.role === 'STAFF' && told.userId !== null && told.userId === viewer.userId;
      shifts.push({
        id: s.id,
        userId: told.userId,
        roleId: s.roleId,
        departmentId: s.departmentId ?? s.role.departmentId,
        shiftTypeId: told.shiftTypeId,
        date: told.date,
        ranges: told.ranges,
        endsNextDay: told.endsNextDay,
        note: told.note,
        status: 'published',
        editedSincePublish: false,
        pendingRequestId: ownRequest ? (pendingFor(told.userId, told.date)?.id ?? null) : null,
      });
      continue;
    }
    const date = toIso(s.date);
    const timing = shiftRangesOf(s, tz);
    shifts.push({
      id: s.id,
      userId: s.userId,
      roleId: s.roleId,
      departmentId: s.departmentId ?? s.role.departmentId,
      shiftTypeId: s.shiftTypeId,
      date,
      ranges: timing.ranges,
      endsNextDay: timing.endsNextDay,
      note: s.note,
      status: s.status === 'DRAFT' ? 'draft' : 'published',
      editedSincePublish: s.editedSincePublish,
      pendingRequestId: pendingFor(s.userId, date)?.id ?? null,
    });
  }
  shifts.sort((a, b) => a.date.localeCompare(b.date) || (a.ranges[0]?.start ?? '').localeCompare(b.ranges[0]?.start ?? ''));

  // Leaves. Managers see every row; staff and kiosk see the told set — the snapshot's when the week has one (a
  // leave added or cleared since publish is not theirs to see yet), else the PUBLISHED rows.
  let leaves: WeekLeaveDto[];
  if (staffView && snapshot) {
    const liveByKey = new Map(leaveRows.map((l) => [leaveKey(l.userId, toIso(l.date)), l]));
    leaves = [];
    for (const [key, type] of Object.entries(snapshot.leaves)) {
      const [userId, date] = key.split('|');
      if (!userId || !date || !Object.hasOwn(LEAVE_LABELS, type)) continue;
      const live = liveByKey.get(key);
      leaves.push({ id: live?.id ?? `told:${key}`, userId, date, type, status: 'published', fromRequest: live ? live.timeOffRequestId !== null : false });
    }
    leaves.sort((a, b) => a.date.localeCompare(b.date));
  } else {
    leaves = leaveRows
      .filter((l) => !staffView || l.status === 'PUBLISHED')
      .map((l): WeekLeaveDto => ({
        id: l.id,
        userId: l.userId,
        date: toIso(l.date),
        type: l.type,
        status: l.status === 'DRAFT' ? 'draft' : 'published',
        fromRequest: l.timeOffRequestId !== null,
      }));
  }

  // People. `alsoDepartmentIds`: departments this person is scheduled under this week other than their own role's.
  const people: WeekPersonDto[] = userRows.map((u): WeekPersonDto => {
    const own = u.role?.departmentId ?? null;
    const also = new Set<string>();
    for (const s of shifts) if (s.userId === u.id && s.departmentId && s.departmentId !== own) also.add(s.departmentId);
    return {
      id: u.id,
      fullName: u.fullName,
      initials: initialsOf(u.fullName),
      roleId: u.roleId,
      roleTitle: u.role?.name ?? null,
      departmentId: own,
      alsoDepartmentIds: [...also],
      isActive: true,
      hasDevice: devices.has(u.id),
    };
  });

  // Requests: pending time off for the week's dates, pending swaps whose shift is in the week. Staff see only their own.
  const mine = (userId: string, other?: string | null) => viewer.role !== 'STAFF' || userId === viewer.userId || other === viewer.userId;
  const requests: WeekRequestDto[] = [];
  if (viewer.role !== 'KIOSK') {
    for (const r of pendingTimeOff) {
      if (!mine(r.userId)) continue;
      const dates: IsoDate[] = [];
      for (let d = toIso(r.startDate); d <= toIso(r.endDate); d = toIso(new Date(dateAt(d).getTime() + 86_400_000))) dates.push(d);
      requests.push({ id: r.id, kind: 'timeOff', status: 'pending', userId: r.userId, dates, reason: r.reason, createdAt: r.createdAt.toISOString() });
    }
    for (const r of pendingSwaps) {
      if (!mine(r.requestedById, r.targetUserId)) continue;
      requests.push({
        id: r.id,
        kind: 'swap',
        status: 'pending',
        userId: r.requestedById,
        dates: [toIso(r.shift.date)],
        shiftId: r.shiftId,
        targetUserId: r.targetUserId,
        // ShiftSwapRequest has no target-shift column (see swapActions.decideSwapRequest's SWAP handling).
        targetShiftId: null,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      });
    }
  }

  // Coverage: counts of PEOPLE per day, plus departments short of their minimum or carrying open shifts.
  const deptOf = (s: WeekShiftDto) => s.departmentId ?? (roleDept.get(s.roleId) ?? OTHER_DEPARTMENT_ID);
  const coverage: CoverageDayDto[] = days.map((date): CoverageDayDto => {
    const dayShifts = shifts.filter((s) => s.date === date);
    const onIds = new Set(dayShifts.map((s) => s.userId).filter((id): id is string => id !== null));
    const leaveIds = new Set(leaves.filter((l) => l.date === date && !onIds.has(l.userId)).map((l) => l.userId));
    const weekday = dateAt(date).getUTCDay();
    const short = new Map<string, number>();
    for (const m of minimums.filter((m) => m.weekday === weekday)) {
      const working = new Set(dayShifts.filter((s) => s.userId && deptOf(s) === m.departmentId).map((s) => s.userId)).size;
      if (working < m.minHeadcount) short.set(m.departmentId, m.minHeadcount - working);
    }
    for (const s of dayShifts) {
      if (s.userId === null) short.set(deptOf(s), (short.get(deptOf(s)) ?? 0) + 1);
    }
    return {
      date,
      on: onIds.size,
      off: Math.max(0, people.length - onIds.size - leaveIds.size),
      leave: leaveIds.size,
      uncovered: [...short.entries()].map(([departmentId, n]) => ({ departmentId, short: n })),
    };
  });

  // Unpublished changes: a draft or edited-since-publish shift, a pending removal (CANCELLED), a draft leave, a
  // leave edited after the last publish — or simply a version the last publish did not see.
  const changedShifts = await db.shift.count({
    where: { locationId, date: { gte: start, lt: end }, OR: [{ status: 'DRAFT' }, { status: 'CANCELLED' }, { editedSincePublish: true }] },
  });
  const changedLeaves = await db.rotaLeave.count({
    where: {
      locationId,
      date: { gte: start, lt: end },
      OR: [{ status: 'DRAFT' }, ...(weekRow?.publishedAt ? [{ updatedAt: { gt: weekRow.publishedAt } }] : [])],
    },
  });
  const versionDrift = weekRow !== null && weekRow.publishedVersion !== null && weekRow.version !== weekRow.publishedVersion;

  return {
    locationId,
    weekStart,
    timezone: tz,
    // TODO(rota-v2): no organisation-level clock setting exists yet; the Design canvas defaults to 24h.
    clock: '24h',
    version: weekRow?.version ?? 1,
    state: weekRow ? (weekRow.state === 'PUBLISHED' ? 'published' : 'draft') : legacyTold ? 'published' : 'draft',
    publishedAt: (weekRow?.publishedAt ?? legacyTold?.publishedAt)?.toISOString() ?? null,
    // A week published before v2 becomes version 1, published, the moment anything writes to it (findOrCreateWeekRow).
    publishedVersion: weekRow?.publishedVersion ?? (legacyTold ? 1 : null),
    // Whether the manager has unpublished work is the manager's business, not the staff view's.
    hasUnpublishedChanges: !staffView && (changedShifts > 0 || changedLeaves > 0 || versionDrift),
    departments,
    shiftTypes,
    people,
    shifts,
    leaves,
    requests,
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Write: one batch patch for every roster mutation
// ---------------------------------------------------------------------------

let warnedMissingVersion = false;

/**
 * Applies a WeekPatchInput atomically. Refusals and version conflicts come
 * back as results (never thrown); anything else is a real error. Callers
 * that already hold a transaction (swapActions) use `applyWeekPatchIn`.
 */
export async function applyWeekPatch(input: ApplyWeekPatchInput, client: typeof prisma = prisma): Promise<WeekPatchResult> {
  let result: WeekPatchOk;
  try {
    result = await withAuditedTransaction(client, (tx) => applyWeekPatchIn(tx, input), () => null, PATCH_TX_OPTIONS);
  } catch (err) {
    if (err instanceof WeekPatchRefusedError) return { result: 'refused', refusal: err.refusal, op: err.op, message: err.message };
    if (err instanceof WeekVersionConflictError) {
      const week = await getWeekDoc({ locationId: input.locationId, weekStart: input.weekStart, viewer: input.viewer ?? MANAGER_VIEWER }, client);
      return { result: 'version_conflict', currentVersion: err.currentVersion, week };
    }
    // The partial unique index `shifts_one_live_per_person_day` is the database's own guard for the person-day
    // rule; every writer checks first under the week lock, so this only fires for a writer outside it.
    if (isPersonDayViolation(err)) return { result: 'refused', refusal: 'already_has_shift', op: -1, message: 'That person already has a shift that day.' };
    throw err;
  }
  // After commit, never inside the transaction: a notice failure must not undo the patch.
  if (result.declinedRequestIds.length > 0) await notifyTimeOffDecided(result.declinedRequestIds, 'declined', client);
  return result;
}

function isPersonDayViolation(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { target?: unknown; modelName?: unknown } } | null;
  if (!e || e.code !== 'P2002') return false;
  const target = JSON.stringify(e.meta?.target ?? '');
  return target.includes('shifts_one_live_per_person_day') || (e.meta?.modelName === 'Shift' && target.includes('user_id') && target.includes('date'));
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 14 Oct" from a YYYY-MM-DD, no timezone involved (the date IS the venue day). */
function shortDay(iso: IsoDate): string {
  const d = dateAt(iso);
  return `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

/** "Tue 14 – Thu 16 Oct", "Thu 30 Oct – Mon 3 Nov", or "Tue 14 Oct" for one day. */
export function dayRangeLabel(startIso: IsoDate, endIso: IsoDate): string {
  if (startIso === endIso) return shortDay(startIso);
  const start = dateAt(startIso);
  const sameMonth = startIso.slice(0, 7) === endIso.slice(0, 7);
  const head = sameMonth ? `${WEEKDAY_NAMES[start.getUTCDay()]} ${start.getUTCDate()}` : shortDay(startIso);
  return `${head} – ${shortDay(endIso)}`;
}

/** Tells each requester their time-off request was approved or declined ("Time off approved: Tue 14 – Thu 16 Oct"). */
export async function notifyTimeOffDecided(requestIds: string[], decision: 'approved' | 'declined', client: typeof prisma = prisma): Promise<void> {
  const requests = await client.timeOffRequest.findMany({ where: { id: { in: requestIds } }, select: { userId: true, startDate: true, endDate: true } });
  const word = decision === 'approved' ? 'approved' : 'declined';
  for (const r of requests) {
    const label = dayRangeLabel(toIso(r.startDate), toIso(r.endDate));
    await notifyUser(r.userId, { title: `Time off ${word}`, body: `Time off ${word}: ${label}`, url: '/scheduling' });
  }
}

/**
 * The transactional core of `applyWeekPatch`. Throws WeekPatchRefusedError /
 * WeekVersionConflictError so the caller's transaction rolls back everything
 * the batch did so far. Each op is validated against the database as it
 * stands when the op runs — which already includes the ops before it in the
 * same batch, so "create A on Monday, move B onto Monday" is refused on op 2.
 */
export async function applyWeekPatchIn(tx: Prisma.TransactionClient, input: ApplyWeekPatchInput): Promise<WeekPatchOk> {
  const { locationId, weekStart, patch, source, actorId } = input;
  if (!isMondayIso(weekStart)) throw refuse('not_monday', -1, WEEK_START_NOT_MONDAY_ERROR);
  if (!Array.isArray(patch.ops)) throw new TypeError('patch.ops must be an array.');

  const tz = await venueTimezoneIn(tx, locationId);
  const daySet = new Set(weekDays(weekStart));

  await lockWeek(tx, locationId, weekStart);
  const week = await findOrCreateWeekRow(tx, locationId, weekStart, tz);
  if (patch.expectedVersion !== undefined) {
    if (typeof patch.expectedVersion !== 'number' || patch.expectedVersion !== week.version) throw new WeekVersionConflictError(week.version);
  } else if (!warnedMissingVersion) {
    // Legacy single-shift callers (routes/shifts.ts, voice) have no version to present yet; logged once so the
    // migration of those callers is visible in production logs without flooding them.
    warnedMissingVersion = true;
    console.warn(`[weekActions] a ${source} patch was applied without expectedVersion — legacy caller, last-writer-wins.`);
  }
  const bumped = await tx.rotaWeek.updateMany({ where: { id: week.id, version: week.version }, data: { version: { increment: 1 } } });
  if (bumped.count === 0) {
    const current = await tx.rotaWeek.findUnique({ where: { id: week.id }, select: { version: true } });
    throw new WeekVersionConflictError(current?.version ?? week.version);
  }
  const version = week.version + 1;

  const results: WeekPatchOk['results'] = [];
  const declinedRequestIds: string[] = [];
  const audit = (entry: { action: 'SHIFT_CREATED' | 'SHIFT_UPDATED' | 'SHIFT_DELETED' | 'LEAVE_MARKED' | 'LEAVE_REMOVED' | 'TIME_OFF_DECLINED'; entityType: string; entityId: string; shiftId?: string | null; note: string }) =>
    writeAuditLog(tx, { locationId, actorId, ...entry, note: `[${source}] ${entry.note}${patch.note ? ` — ${patch.note}` : ''}` });

  /**
   * A real day of this week that has not passed. Imports may backfill the past; a swap approval may record a
   * cover that already happened (as it always could before v2).
   */
  const assertDay = (date: unknown, i: number): IsoDate => {
    if (!isRealDate(date) || !daySet.has(date)) throw refuse('outside_week', i, `Date "${String(date)}" is not in the week of ${weekStart}.`);
    if (source !== 'import' && source !== 'swap' && isPastVenueDay(date, tz)) throw refuse('past_day', i, `${date} has already passed.`);
    return date;
  };
  const normalizeNote = (note: string | null | undefined, i: number): string | null => {
    if (note === undefined || note === null) return null;
    const trimmed = String(note).trim();
    if (trimmed.length > NOTE_MAX) throw refuse('note_too_long', i, `A shift note is at most ${NOTE_MAX} characters.`);
    return trimmed || null;
  };
  const assertDepartment = async (departmentId: string | null, i: number): Promise<string | null> => {
    if (!departmentId) return null;
    const dept = await tx.department.findUnique({ where: { id: departmentId }, select: { locationId: true } });
    if (!dept || dept.locationId !== locationId) throw refuse('unknown_role', i, `Department "${departmentId}" not found.`);
    return departmentId;
  };

  /** Ranges + the type they came from: a venue shift type, custom ranges, or custom ranges labelled with a type. */
  const resolveTiming = async (want: { shiftTypeId?: string | null; ranges?: TimeRange[] }, i: number) => {
    let shiftTypeId: string | null = null;
    let typeRanges: TimeRange[] | null = null;
    if (typeof want.shiftTypeId === 'string') {
      const type = await tx.shiftType.findUnique({ where: { id: want.shiftTypeId } });
      if (!type || type.locationId !== locationId || type.archivedAt) throw refuse('unknown_shift_type', i, `Shift type "${want.shiftTypeId}" not found or archived.`);
      if (!validateRanges(type.ranges)) throw refuse('bad_ranges', i, `Shift type "${type.name}" has no usable times.`);
      shiftTypeId = type.id;
      typeRanges = type.ranges;
    }
    let ranges: TimeRange[] | null = typeRanges;
    if (want.ranges !== undefined) {
      if (!validateRanges(want.ranges)) throw refuse('bad_ranges', i, 'Times must be 1–2 HH:MM ranges; only the last may cross midnight.');
      ranges = want.ranges;
    }
    if (!ranges) throw refuse('bad_ranges', i, 'A shift needs a shift type or times.');
    return { ranges: ranges.map((r) => ({ start: r.start, end: r.end })), endsNextDay: rangesEndNextDay(ranges), shiftTypeId };
  };

  /**
   * The person-day rule for a shift landing on (userId, date): no other live
   * shift, no blocking leave (Day off / Half day give way to the shift and
   * are removed), no PENDING time-off request unless the caller overrides —
   * in which case the request is declined in this same transaction.
   */
  const claimPersonDay = async (userId: string, date: IsoDate, excludeShiftId: string | undefined, i: number) => {
    const d = dateAt(date);
    const other = await tx.shift.findFirst({
      where: { userId, date: d, status: { not: 'CANCELLED' }, ...(excludeShiftId ? { id: { not: excludeShiftId } } : {}) },
      select: { id: true },
    });
    if (other) throw refuse('already_has_shift', i, 'That person already has a shift that day.');
    const leave = await tx.rotaLeave.findUnique({ where: { userId_date: { userId, date: d } } });
    if (leave) {
      // Leave from an approved time-off request is locked whatever its type (B2 state 3a): the approval stands.
      if (leaveBlocksShifts(leave.type) || leave.timeOffRequestId !== null) {
        throw refuse('person_on_leave', i, `That person is on ${LEAVE_LABELS[leave.type].toLowerCase()} that day.`);
      }
      await tx.rotaLeave.delete({ where: { id: leave.id } });
      await audit({ action: 'LEAVE_REMOVED', entityType: 'RotaLeave', entityId: leave.id, note: `${LEAVE_LABELS[leave.type]} on ${date} replaced by a shift` });
    }
    const pending = await tx.timeOffRequest.findFirst({ where: { userId, status: 'PENDING', startDate: { lte: d }, endDate: { gte: d } }, select: { id: true } });
    if (pending) {
      if (!patch.overridePendingRequests) throw refuse('pending_request', i, 'That person has a pending time-off request covering that day.');
      // Conditional, like every other decision on a request: a concurrent approve/decline of the same request wins
      // or loses cleanly instead of being overwritten.
      const declined = await tx.timeOffRequest.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: { status: 'DECLINED', reviewedById: actorId, reviewedAt: new Date(), managerNote: 'Declined by scheduling' },
      });
      if (declined.count === 0) throw refuse('pending_request', i, 'That time-off request was decided a moment ago — reload and try again.');
      if (!declinedRequestIds.includes(pending.id)) declinedRequestIds.push(pending.id);
      await audit({ action: 'TIME_OFF_DECLINED', entityType: 'TimeOffRequest', entityId: pending.id, note: `Declined by scheduling a shift on ${date}` });
    }
  };

  /** A cross-midnight shift may still collide with the neighbouring day's shift of the same person. */
  const assertNoOverlap = async (userId: string, startTime: Date, endTime: Date, excludeShiftId: string | undefined, i: number) => {
    const clash = await findOverlappingShift({ userId, locationId, startTime, endTime, excludeShiftId }, tx);
    if (clash) throw refuse('overlap', i, `Those times overlap another shift of that person (${formatVenueTime(clash.startTime, tz)}–${formatVenueTime(clash.endTime, tz)}).`);
  };

  /** Floor-section assignments belong to a person-day; when the shift leaves it, they go with it. */
  const clearSections = async (userId: string | null, date: IsoDate) => {
    if (!userId) return;
    await tx.sectionAssignment.deleteMany({ where: { staffId: userId, shiftDate: dateAt(date) } });
  };

  const loadLiveShift = async (shiftId: string, i: number) => {
    const shift = await tx.shift.findUnique({ where: { id: shiftId }, include: { role: { select: { departmentId: true } } } });
    if (!shift || shift.locationId !== locationId || shift.status === 'CANCELLED') throw refuse('unknown_shift', i, `Shift "${shiftId}" not found.`);
    return shift;
  };

  for (let i = 0; i < patch.ops.length; i++) {
    const op: WeekPatchOp = patch.ops[i]!;
    switch (op.op) {
      case 'create': {
        const date = assertDay(op.date, i);
        const userId = op.userId ?? null;
        const user = userId ? await findVenueUser(userId, locationId, { activeOnly: true }, tx) : null;
        if (userId && !user) throw refuse('unknown_person', i, `Staff member "${userId}" not found.`);
        const roleId = op.roleId ?? user?.roleId ?? null;
        const role = roleId ? await findActiveVenueRole(roleId, locationId, tx) : null;
        if (!role) throw refuse('unknown_role', i, roleId ? `Role "${roleId}" not found or no longer active.` : 'A shift needs a role (the person has none).');
        const departmentId = await assertDepartment(op.departmentId === undefined ? role.departmentId : op.departmentId, i);
        const timing = await resolveTiming({ shiftTypeId: op.shiftTypeId, ranges: op.ranges }, i);
        const note = normalizeNote(op.note, i);
        const { startTime, endTime } = shiftInstantsOf(date, timing.ranges, tz);
        if (userId) {
          await claimPersonDay(userId, date, undefined, i);
          await assertNoOverlap(userId, startTime, endTime, undefined, i);
        }
        const created = await tx.shift.create({
          data: {
            locationId,
            roleId: role.id,
            userId,
            createdById: actorId,
            date: dateAt(date),
            startTime,
            endTime,
            status: 'DRAFT',
            shiftTypeId: timing.shiftTypeId,
            departmentId,
            ranges: timing.ranges as unknown as Prisma.InputJsonValue,
            endsNextDay: timing.endsNextDay,
            note,
          },
          select: { id: true },
        });
        await audit({ action: 'SHIFT_CREATED', entityType: 'Shift', entityId: created.id, shiftId: created.id, note: `Created a shift on ${date}` });
        results.push({ op: i, ...(op.tempId !== undefined ? { tempId: op.tempId } : {}), shiftId: created.id });
        break;
      }
      case 'update': {
        const shift = await loadLiveShift(op.shiftId, i);
        const oldDate = assertDay(toIso(shift.date), i);
        const date = op.date !== undefined ? assertDay(op.date, i) : oldDate;
        const userId = op.userId === undefined ? shift.userId : op.userId;
        if (userId && userId !== shift.userId && !(await findVenueUser(userId, locationId, { activeOnly: true }, tx))) {
          throw refuse('unknown_person', i, `Staff member "${userId}" not found.`);
        }
        let roleId = shift.roleId;
        let roleDepartmentId = shift.role.departmentId;
        if (op.roleId !== undefined && op.roleId !== shift.roleId) {
          const role = await findActiveVenueRole(op.roleId, locationId, tx);
          if (!role) throw refuse('unknown_role', i, `Role "${op.roleId}" not found or no longer active.`);
          roleId = role.id;
          roleDepartmentId = role.departmentId;
        }
        const departmentId = await assertDepartment(
          op.departmentId !== undefined ? op.departmentId : roleId !== shift.roleId ? roleDepartmentId : shift.departmentId,
          i,
        );
        // Times: a (new) type's ranges, or new custom ranges, or the shift's own. Only a type named by THIS op is
        // checked against the venue's live types: a shift keeps the label of a type archived since it was made.
        const current = shiftRangesOf(shift, tz);
        const keptTypeId = op.shiftTypeId === null ? null : shift.shiftTypeId;
        const timing =
          typeof op.shiftTypeId === 'string'
            ? await resolveTiming({ shiftTypeId: op.shiftTypeId, ranges: op.ranges }, i)
            : op.ranges !== undefined
              ? { ...(await resolveTiming({ ranges: op.ranges }, i)), shiftTypeId: keptTypeId }
              : { ranges: current.ranges, endsNextDay: current.endsNextDay, shiftTypeId: keptTypeId };
        const note = op.note === undefined ? shift.note : normalizeNote(op.note, i);
        const { startTime, endTime } = shiftInstantsOf(date, timing.ranges, tz);
        const moved = userId !== shift.userId || date !== oldDate;
        if (userId) {
          if (moved) await claimPersonDay(userId, date, shift.id, i);
          await assertNoOverlap(userId, startTime, endTime, shift.id, i);
        }
        // A published shift is edited in place; `editedSincePublish` marks the chip (gold dot) and
        // `publishedSnapshot` still holds what staff were last TOLD — the staff view (getWeekDoc, my-shifts)
        // reads that until the next publish. Readers of the live row (attendance, voice, the legacy kiosk
        // list) see the edit at once: see docs/rota-builder-v2.md, "What staff see".
        await tx.shift.update({
          where: { id: shift.id },
          data: {
            userId,
            roleId,
            departmentId,
            shiftTypeId: timing.shiftTypeId,
            date: dateAt(date),
            startTime,
            endTime,
            ranges: timing.ranges as unknown as Prisma.InputJsonValue,
            endsNextDay: timing.endsNextDay,
            note,
            editedSincePublish: shift.status === 'DRAFT' ? shift.editedSincePublish : true,
          },
        });
        if (moved) await clearSections(shift.userId, oldDate);
        await audit({ action: 'SHIFT_UPDATED', entityType: 'Shift', entityId: shift.id, shiftId: shift.id, note: `Updated the shift on ${date}` });
        results.push({ op: i, shiftId: shift.id });
        break;
      }
      case 'delete': {
        const shift = await loadLiveShift(op.shiftId, i);
        const oldDate = assertDay(toIso(shift.date), i);
        if (shift.status === 'DRAFT') {
          // Never published: nothing to diff, so it simply goes. Audit row first (its shiftId is null: the shift is gone after).
          await audit({ action: 'SHIFT_DELETED', entityType: 'Shift', entityId: shift.id, shiftId: null, note: `Deleted the draft shift on ${oldDate}` });
          await tx.shift.delete({ where: { id: shift.id } });
        } else {
          // Published: soft-cancel so the publish diff can tell the person their shift was removed; publishWeek hard-deletes it afterwards.
          await tx.shift.update({ where: { id: shift.id }, data: { status: 'CANCELLED', editedSincePublish: true } });
          await audit({ action: 'SHIFT_DELETED', entityType: 'Shift', entityId: shift.id, shiftId: shift.id, note: `Removed the published shift on ${oldDate} (pending publish)` });
        }
        await clearSections(shift.userId, oldDate);
        results.push({ op: i, shiftId: shift.id });
        break;
      }
      case 'setLeave': {
        const date = assertDay(op.date, i);
        if (!(await findVenueUser(op.userId, locationId, { activeOnly: true }, tx))) throw refuse('unknown_person', i, `Staff member "${op.userId}" not found.`);
        if (typeof op.type !== 'string' || !Object.hasOwn(LEAVE_LABELS, op.type)) throw refuse('bad_leave_type', i, `Unknown leave type "${String(op.type)}".`);
        const type: LeaveTypeCode = op.type;
        const live = await tx.shift.findFirst({ where: { userId: op.userId, date: dateAt(date), status: { not: 'CANCELLED' } }, select: { id: true } });
        // A leave day never also holds a shift, whatever the type: remove or move the shift first.
        if (live) throw refuse('leave_over_shift', i, 'That person has a shift that day — remove it before marking leave.');
        const leave = await tx.rotaLeave.upsert({
          where: { userId_date: { userId: op.userId, date: dateAt(date) } },
          create: { locationId, userId: op.userId, createdById: actorId, date: dateAt(date), type, status: 'DRAFT' },
          update: { type },
          select: { id: true },
        });
        await audit({ action: 'LEAVE_MARKED', entityType: 'RotaLeave', entityId: leave.id, note: `${LEAVE_LABELS[type]} on ${date}` });
        results.push({ op: i, leaveId: leave.id });
        break;
      }
      case 'clearLeave': {
        const date = assertDay(op.date, i);
        if (!(await findVenueUser(op.userId, locationId, { activeOnly: true }, tx))) throw refuse('unknown_person', i, `Staff member "${op.userId}" not found.`);
        const leave = await tx.rotaLeave.findUnique({ where: { userId_date: { userId: op.userId, date: dateAt(date) } } });
        if (leave) {
          // Clearing a leave created by an approved request does not reopen that request: the approval stands in the request log.
          await tx.rotaLeave.delete({ where: { id: leave.id } });
          await audit({ action: 'LEAVE_REMOVED', entityType: 'RotaLeave', entityId: leave.id, note: `${LEAVE_LABELS[leave.type]} on ${date} removed` });
          results.push({ op: i, leaveId: leave.id });
        } else {
          results.push({ op: i });
        }
        break;
      }
      default: {
        const unknown: never = op;
        throw new TypeError(`Unknown week patch op: ${JSON.stringify(unknown)}`);
      }
    }
  }

  await writeAuditLog(tx, {
    locationId,
    actorId,
    action: 'WEEK_PATCHED',
    entityType: 'RotaWeek',
    entityId: week.id,
    note: `[${source}] ${patch.ops.length} change(s) to the week of ${weekStart} → v${version}${declinedRequestIds.length ? `, ${declinedRequestIds.length} request(s) declined` : ''}${patch.note ? ` — ${patch.note}` : ''}`,
  });

  return {
    result: 'ok',
    version,
    results,
    declinedRequestIds,
    week: await getWeekDoc({ locationId, weekStart, viewer: input.viewer ?? MANAGER_VIEWER }, tx),
  };
}

// ---------------------------------------------------------------------------
// Publish: snapshot, diff, fingerprint
// ---------------------------------------------------------------------------

/** What staff were last told, per shift id and per person-day leave — `rota_weeks.published_snapshot`. */
export interface WeekSnapshot {
  shifts: Record<string, { userId: string | null; date: IsoDate; ranges: TimeRange[]; endsNextDay: boolean; shiftTypeId: string | null; note: string | null }>;
  leaves: Record<string, LeaveTypeCode>;
}

const leaveKey = (userId: string, date: IsoDate) => `${userId}|${date}`;

/**
 * The live rows of a week (shifts not CANCELLED, every leave) in snapshot shape. `publishedOnly`: only
 * PUBLISHED/COMPLETED shifts and PUBLISHED leaves (what a pre-v2 week told staff). `shiftIds`: only those
 * shifts and no leaves (the rows a roster import just published).
 */
async function buildSnapshot(
  db: Db,
  locationId: string,
  weekStart: IsoDate,
  tz: string,
  opts: { publishedOnly?: boolean; shiftIds?: string[] } = {},
): Promise<WeekSnapshot> {
  const { start, end } = calendarWeekRange(weekStart);
  const shifts = await db.shift.findMany({
    where: {
      locationId,
      date: { gte: start, lt: end },
      status: opts.publishedOnly ? { in: ['PUBLISHED', 'COMPLETED'] } : { not: 'CANCELLED' },
      ...(opts.shiftIds ? { id: { in: opts.shiftIds } } : {}),
    },
    select: { id: true, userId: true, date: true, startTime: true, endTime: true, ranges: true, endsNextDay: true, shiftTypeId: true, note: true },
  });
  const leaves = opts.shiftIds
    ? []
    : await db.rotaLeave.findMany({
        where: { locationId, date: { gte: start, lt: end }, ...(opts.publishedOnly ? { status: 'PUBLISHED' as const } : {}) },
        select: { userId: true, date: true, type: true },
      });
  const snapshot: WeekSnapshot = { shifts: {}, leaves: {} };
  for (const s of shifts) {
    const timing = shiftRangesOf(s, tz);
    snapshot.shifts[s.id] = { userId: s.userId, date: toIso(s.date), ranges: timing.ranges, endsNextDay: timing.endsNextDay, shiftTypeId: s.shiftTypeId, note: s.note };
  }
  for (const l of leaves) snapshot.leaves[leaveKey(l.userId, toIso(l.date))] = l.type;
  return snapshot;
}

function readSnapshot(value: Prisma.JsonValue | null | undefined): WeekSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<WeekSnapshot>;
  return { shifts: v.shifts && typeof v.shifts === 'object' ? v.shifts : {}, leaves: v.leaves && typeof v.leaves === 'object' ? v.leaves : {} };
}

/**
 * Records the week's live rows as its published snapshot and bumps the
 * version (the new version is the published one). Used by `publishWeek` and
 * by the legacy publish (rotaActions.publishRota), which publish the whole
 * week. The roster import passes `mergeShiftIds`: only the rows it just wrote
 * as PUBLISHED join the existing snapshot, so a manager's drafts in the same
 * week are not recorded as told (they would never be announced otherwise).
 * The caller holds the transaction; `expectVersion` makes the bump conditional.
 */
export async function snapshotWeek(
  tx: Prisma.TransactionClient,
  locationId: string,
  weekStart: IsoDate,
  opts: { publishedById?: string | null; expectVersion?: number; publishedAt?: Date; mergeShiftIds?: string[] } = {},
): Promise<{ id: string; version: number; publishedAt: Date }> {
  const tz = await venueTimezoneIn(tx, locationId);
  await lockWeek(tx, locationId, weekStart);
  const row = await findOrCreateWeekRow(tx, locationId, weekStart, tz);
  if (opts.expectVersion !== undefined && row.version !== opts.expectVersion) throw new WeekVersionConflictError(row.version);
  let snapshot: WeekSnapshot;
  if (opts.mergeShiftIds) {
    snapshot = readSnapshot(row.publishedSnapshot) ?? { shifts: {}, leaves: {} };
    const added = await buildSnapshot(tx, locationId, weekStart, tz, { shiftIds: opts.mergeShiftIds });
    for (const [id, s] of Object.entries(added.shifts)) {
      snapshot.shifts[id] = s;
      // A person-day holds a shift or a leave, never both.
      if (s.userId) delete snapshot.leaves[leaveKey(s.userId, s.date)];
    }
  } else {
    snapshot = await buildSnapshot(tx, locationId, weekStart, tz);
  }
  const publishedAt = opts.publishedAt ?? new Date();
  const version = row.version + 1;
  const updated = await tx.rotaWeek.updateMany({
    where: { id: row.id, version: row.version },
    data: {
      version,
      state: 'PUBLISHED',
      publishedVersion: version,
      publishedAt,
      ...(opts.publishedById !== undefined ? { publishedById: opts.publishedById } : {}),
      publishedSnapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0) throw new WeekVersionConflictError(row.version);
  return { id: row.id, version, publishedAt };
}

/** "Evening 16:00–01:00", "07:00–11:00 + 17:00–23:00". */
function renderShift(s: { ranges: TimeRange[]; shiftTypeId: string | null }, typeNames: Map<string, string>): string {
  const times = s.ranges.map((r) => formatRange(r, '24h')).join(' + ');
  const name = s.shiftTypeId ? typeNames.get(s.shiftTypeId) : undefined;
  return name ? `${name} ${times}` : times;
}

/**
 * The per-person diff between what staff were last told (`publishedSnapshot`)
 * and the week as it stands now. A removal is a change for the snapshot's
 * person; a reassignment is a change for both people. The fingerprint binds a
 * publish to exactly this diff at exactly this version.
 */
export async function previewWeekPublish(input: { locationId: string; weekStart: IsoDate }, db: Db = prisma): Promise<PublishPreviewDto> {
  const { locationId, weekStart } = input;
  if (!isMondayIso(weekStart)) throw new Error(WEEK_START_NOT_MONDAY_ERROR);
  const tz = await venueTimezoneIn(db, locationId);
  const row = await db.rotaWeek.findUnique({ where: { locationId_weekStart: { locationId, weekStart: dateAt(weekStart) } } });
  // No row yet: a week published before v2 diffs against what it told staff (the row will be seeded with exactly that).
  const published = row ? readSnapshot(row.publishedSnapshot) : ((await legacyToldSnapshot(db, locationId, weekStart, tz))?.snapshot ?? null);
  const current = await buildSnapshot(db, locationId, weekStart, tz);
  const typeNames = new Map((await db.shiftType.findMany({ where: { locationId }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));

  type Cell = { text: string; startsAt: Date | null };
  const cells = (snap: WeekSnapshot): Map<string, Cell> => {
    const out = new Map<string, Cell>();
    for (const s of Object.values(snap.shifts)) {
      if (!s.userId || !validateRanges(s.ranges)) continue;
      out.set(leaveKey(s.userId, s.date), { text: renderShift(s, typeNames), startsAt: shiftInstantsOf(s.date, s.ranges, tz).startTime });
    }
    for (const [key, type] of Object.entries(snap.leaves)) {
      if (!out.has(key)) out.set(key, { text: LEAVE_LABELS[type] ?? String(type), startsAt: null });
    }
    return out;
  };
  const before = published ? cells(published) : new Map<string, Cell>();
  const after = cells(current);

  const now = Date.now();
  const byUser = new Map<string, PublishDiffRow['changes']>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(key);
    const a = after.get(key);
    if (b?.text === a?.text) continue;
    const [userId, date] = key.split('|') as [string, IsoDate];
    const startsAt = a?.startsAt ?? b?.startsAt ?? null;
    const list = byUser.get(userId) ?? [];
    list.push({ date, before: b?.text ?? null, after: a?.text ?? null, urgent: startsAt !== null && startsAt.getTime() - now < URGENT_WINDOW_MS });
    byUser.set(userId, list);
  }

  const userIds = [...byUser.keys()];
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
  const names = new Map(users.map((u) => [u.id, u.fullName]));
  const devices = await deviceHolders(db, userIds);
  const rows: PublishDiffRow[] = userIds
    .map((userId): PublishDiffRow => ({
      userId,
      fullName: names.get(userId) ?? 'Former staff member',
      hasDevice: devices.has(userId),
      changes: byUser.get(userId)!.slice().sort((x, y) => x.date.localeCompare(y.date)),
    }))
    .sort((x, y) => x.fullName.localeCompare(y.fullName) || x.userId.localeCompare(y.userId));

  const doc = await getWeekDoc({ locationId, weekStart, viewer: MANAGER_VIEWER }, db);
  const deptNames = new Map(doc.departments.map((d) => [d.id, d.name]));
  const uncovered = doc.coverage.flatMap((day) =>
    day.uncovered.map((u) => ({ date: day.date, departmentId: u.departmentId, departmentName: deptNames.get(u.departmentId) ?? 'Other', short: u.short })),
  );

  const version = row?.version ?? 1;
  const canonical = rows
    .flatMap((r) => r.changes.map((c) => ({ userId: r.userId, date: c.date, before: c.before, after: c.after })))
    .sort((x, y) => x.userId.localeCompare(y.userId) || x.date.localeCompare(y.date));
  const fingerprint = createHash('sha256').update(JSON.stringify({ locationId, weekStart, version, rows: canonical })).digest('hex');

  return {
    weekStart,
    version,
    firstPublish: published === null,
    changeCount: canonical.length,
    notifiedCount: rows.filter((r) => r.hasDevice).length,
    noDeviceUserIds: rows.filter((r) => !r.hasDevice).map((r) => r.userId),
    rows,
    uncovered,
    fingerprint,
  };
}

/** The notification line for one person: the days and before→after, or a count when it would not fit. */
export function publishNoticeBody(row: PublishDiffRow, weekStart: IsoDate, firstPublish: boolean): string {
  const limit = 140;
  if (row.changes.length > 3) return `${row.changes.length} changes to your week of ${shortDay(weekStart)} — open the app for details.`;
  const line = row.changes
    .map((c) => (firstPublish || c.before === null ? `${shortDay(c.date)}: ${c.after ?? 'removed'}` : `${shortDay(c.date)}: ${c.before} → ${c.after ?? 'removed'}`))
    .join('; ');
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

type PublishOutcome =
  | { result: 'ok'; version: number; publishedAt: Date; preview: PublishPreviewDto }
  | { result: 'fingerprint_mismatch'; preview: PublishPreviewDto }
  | { result: 'empty'; message: string };

/**
 * Publishes the week the manager just previewed: same lock + version check
 * as a patch, the preview recomputed and compared by fingerprint (so nothing
 * changed under the confirm sheet), then drafts → PUBLISHED, pending
 * removals hard-deleted, a fresh snapshot, the legacy RotaPublish row kept
 * in step, and one notice per changed person with a device — sent after
 * commit, never inside the transaction (a push failure must not roll back
 * the publish).
 */
export async function publishWeek(
  input: { locationId: string; weekStart: IsoDate; actorId: string; expectedVersion: number; fingerprint: string },
  client: typeof prisma = prisma,
): Promise<PublishResult> {
  const { locationId, weekStart, actorId } = input;
  if (!isMondayIso(weekStart)) throw new Error(WEEK_START_NOT_MONDAY_ERROR);
  const outcome = await withAuditedTransaction<PublishOutcome>(
    client,
    async (tx) => {
      const tz = await venueTimezoneIn(tx, locationId);
      await lockWeek(tx, locationId, weekStart);
      const row = await findOrCreateWeekRow(tx, locationId, weekStart, tz);
      if (row.version !== input.expectedVersion) throw new WeekVersionConflictError(row.version);
      const preview = await previewWeekPublish({ locationId, weekStart }, tx);
      if (preview.fingerprint !== input.fingerprint) return { result: 'fingerprint_mismatch', preview };

      const { start, end } = calendarWeekRange(weekStart);
      const inWeek = { locationId, date: { gte: start, lt: end } };
      const liveShifts = await tx.shift.count({ where: { ...inWeek, status: { not: 'CANCELLED' } } });
      const leaves = await tx.rotaLeave.count({ where: inWeek });
      // A week that only removes shifts still publishes (people must be told); a week with nothing at all does not.
      if (liveShifts === 0 && leaves === 0 && preview.changeCount === 0) return { result: 'empty', message: 'Nothing to publish for this week yet.' };

      const publishedAt = new Date();
      await tx.shift.updateMany({ where: { ...inWeek, status: 'DRAFT' }, data: { status: 'PUBLISHED', publishedAt } });
      await tx.shift.updateMany({ where: { ...inWeek, status: { not: 'CANCELLED' }, editedSincePublish: true }, data: { editedSincePublish: false } });
      // Removals are now reflected by their absence from the new snapshot.
      await tx.shift.deleteMany({ where: { ...inWeek, status: 'CANCELLED' } });
      // `updatedAt` pinned to the publish instant: getWeekDoc reads a leave touched AFTER publishedAt as an
      // unpublished change, and Prisma's @updatedAt would otherwise land a few ms later than publishedAt.
      await tx.rotaLeave.updateMany({ where: { ...inWeek, status: 'DRAFT' }, data: { status: 'PUBLISHED', updatedAt: publishedAt } });
      const snap = await snapshotWeek(tx, locationId, weekStart, { publishedById: actorId, expectVersion: row.version, publishedAt });

      // Legacy readers (GET /api/shifts/:locationId/publish-status, the old RotaBuilder banner) key on this row.
      await tx.rotaPublish.upsert({
        where: { locationId_weekStart: { locationId, weekStart: start } },
        create: { locationId, weekStart: start, publishedAt, publishedById: actorId, notifiedCount: preview.notifiedCount },
        update: { publishedAt, publishedById: actorId, notifiedCount: preview.notifiedCount },
      });
      await writeAuditLog(tx, {
        locationId,
        actorId,
        action: 'WEEK_PUBLISHED',
        entityType: 'RotaWeek',
        entityId: row.id,
        note: `Published the week of ${weekStart} as v${snap.version}: ${preview.changeCount} change(s) for ${preview.rows.length} people, ${preview.notifiedCount} notified.`,
      });
      return { result: 'ok', version: snap.version, publishedAt, preview };
    },
    () => null,
    PATCH_TX_OPTIONS,
  ).catch((err: unknown) => {
    if (err instanceof WeekVersionConflictError) return { result: 'version_conflict' as const, currentVersion: err.currentVersion };
    throw err;
  });

  if (outcome.result !== 'ok') return outcome;
  const { preview } = outcome;
  const title = preview.firstPublish ? 'Your week is ready' : 'Your week changed';
  await Promise.all(
    preview.rows
      .filter((r) => r.hasDevice)
      .map((r) => notifyUser(r.userId, { title, body: publishNoticeBody(r, weekStart, preview.firstPublish), url: '/my-shifts' })),
  );
  return {
    result: 'ok',
    version: outcome.version,
    publishedAt: outcome.publishedAt.toISOString(),
    notifiedCount: preview.notifiedCount,
    noDeviceUserIds: preview.noDeviceUserIds,
  };
}
