import type { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from './normalize.js';
import { lockWeek, snapshotWeek } from '../lib/actions/weekActions.js';
import { leaveBlocksShifts, validateRanges, type LeaveTypeCode, type TimeRange } from '../../../shared/rotaWeek.js';
import { canonicalRoleName, nameKey, personNameKey, stripRoleOrdinal, TEAM_MEMBER_ROLE_NAME } from './resolveRows.js';
import type { PreviewRow } from './types.js';
import type {
  AddedPerson,
  ConfirmedPerson,
  ConfirmImportResult,
  ConfirmPersonDecision,
  ImportOverlap,
  PersonPreview,
} from './rosterContract.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/** A confirm the manager has to fix (a link to someone not at this venue, an empty name): a 400. */
export class RosterImportError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'RosterImportError';
  }
}

export interface RosterImportInput {
  locationId: string;
  /** Who confirmed (audit). */
  actorId: string;
  /** Written to Shift.createdById. */
  createdById: string | null;
  /** The batch's rows after the manager's removals and edits (dates as read; the week change is applied here). */
  rows: PreviewRow[];
  /** One entry per person in the batch. */
  people: PersonPreview[];
  /** The manager's decision per personKey. A person without one gets the conservative default (see defaultDecision). */
  decisions: Map<string, ConfirmPersonDecision>;
  addedPeople: AddedPerson[];
  /** Whole days to move every shift by (a multiple of 7: the manager confirmed a different week). */
  weekDeltaDays: number;
  /** Save "printed role label -> role" for labels the manager assigned by hand. */
  rememberRoleMappings: boolean;
}

export interface RosterImportResult extends ConfirmImportResult {
  /** Every shift written, by preview rowNumber (date after any week change). */
  rows: { rowNumber: number; shiftId: string; userId: string | null; date: string }[];
  /** Rows not written: skipped people's shifts, identical shifts already on the rota, overlaps. */
  skippedRowCount: number;
}

/**
 * Used when the request carries no decision for a person (an older client): an exact match
 * (or a remembered link) is linked, everyone else is created. A close-but-different name is
 * never merged into someone else without the manager saying so.
 */
function defaultDecision(person: PersonPreview): ConfirmPersonDecision {
  return person.matchedUserId
    ? { personKey: person.personKey, action: 'link', userId: person.matchedUserId }
    : { personKey: person.personKey, action: 'create' };
}

export function addDaysIso(iso: string, days: number): string {
  if (!days) return iso;
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The Monday (YYYY-MM-DD) of the week `iso` falls in. */
export function mondayOfIso(iso: string): string {
  const day = new Date(`${iso}T00:00:00.000Z`).getUTCDay();
  return addDaysIso(iso, day === 0 ? -6 : 1 - day);
}

const MAX_NAME_LENGTH = 120;
const MAX_ROLE_LENGTH = 80;

type Tx = Prisma.TransactionClient;
type ActiveUser = { id: string; fullName: string; roleId: string | null };

/** The venue's roles, plus "use or create" for a role name the manager picked. */
async function loadRoles(tx: Tx, locationId: string) {
  const roles = await tx.role.findMany({ where: { locationId }, select: { id: true, name: true, isActive: true } });
  const activeIds = new Set(roles.filter((r) => r.isActive).map((r) => r.id));
  const nameById = new Map(roles.map((r) => [r.id, r.name]));
  const activeByKey = new Map(roles.filter((r) => r.isActive).map((r) => [nameKey(r.name), r.id]));
  const inactiveByKey = new Map(roles.filter((r) => !r.isActive).map((r) => [nameKey(r.name), r.id]));

  /** Existing, reactivated (a deactivated role still owns its name), or created under the canonical name, like the edits path. */
  const ensure = async (rawName: string): Promise<string> => {
    const trimmed = rawName.trim().replace(/\s+/g, ' ').slice(0, MAX_ROLE_LENGTH);
    const canonical = canonicalRoleName(trimmed);
    const existing = activeByKey.get(nameKey(trimmed)) ?? activeByKey.get(nameKey(canonical));
    if (existing) return existing;
    const key = nameKey(canonical);
    const inactiveId = inactiveByKey.get(key);
    const id = inactiveId
      ? (await tx.role.update({ where: { id: inactiveId }, data: { isActive: true }, select: { id: true } })).id
      : (await tx.role.create({ data: { locationId, name: canonical }, select: { id: true } })).id;
    inactiveByKey.delete(key);
    activeByKey.set(key, id);
    activeIds.add(id);
    nameById.set(id, canonical);
    return id;
  };
  const active = (id: string | null | undefined): string | null => (id && activeIds.has(id) ? id : null);
  const lookup = (rawName: string): string | null => activeByKey.get(nameKey(rawName)) ?? null;
  return { ensure, active, lookup, nameById };
}

/**
 * Commits a reviewed roster: creates or links one staff member per person and writes their
 * shifts. Idempotent per venue: a person is matched by normalized name to an active staff
 * member before anyone new is created, and a shift identical to one already on the rota
 * (same person, start, end) is skipped and counted — importing the same roster twice creates
 * no new staff and no new shifts. A different shift overlapping one the person already has is
 * not written and is reported back. Role-unresolved people get their existing role, or the
 * venue's "Team member" role, so nobody is dropped.
 *
 * Runs inside the caller's transaction (`tx`) and takes a per-venue advisory lock first, so a
 * double-submit or two concurrent confirms serialize and the second sees the first's writes.
 */
export async function persistRosterImport(tx: Tx, input: RosterImportInput): Promise<RosterImportResult> {
  const { locationId } = input;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`roster-import:${locationId}`}))::text`;

  const location = await tx.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  const tz = location?.timezone || DEFAULT_VENUE_TIMEZONE;
  const roles = await loadRoles(tx, locationId);

  const activeUsers: ActiveUser[] = await tx.user.findMany({
    where: { locationId, isActive: true, deletedAt: null },
    select: { id: true, fullName: true, roleId: true },
    orderBy: { createdAt: 'asc' },
  });
  const userById = new Map(activeUsers.map((u) => [u.id, u]));
  const userByKey = new Map<string, ActiveUser>();
  for (const user of activeUsers) {
    const key = personNameKey(user.fullName);
    if (key && !userByKey.has(key)) userByKey.set(key, user);
  }

  // Added by hand on the review screen: people with no shifts, always "create".
  const decisions = new Map(input.decisions);
  const people: PersonPreview[] = [
    ...input.people,
    ...input.addedPeople.map((added, i): PersonPreview => {
      const personKey = `added:${i}`;
      decisions.set(personKey, { personKey, action: 'create', name: added.name, roleName: added.roleName });
      return {
        personKey,
        name: added.name,
        normalizedName: personNameKey(added.name),
        roleLabel: null,
        resolvedRoleId: null,
        section: null,
        status: 'new',
        matchedUserId: null,
        flags: [],
        shiftCount: 0,
        rowNumbers: [],
        sourceRows: [],
      };
    }),
  ];

  interface PendingUser {
    name: string;
    roleId: string | null;
    id?: string;
  }
  interface Plan {
    person: PersonPreview;
    decision: ConfirmPersonDecision;
    explicit: boolean;
    existing?: ActiveUser;
    pending?: PendingUser;
    explicitRoleId: string | null;
    roleId: string | null;
  }

  // Who each person becomes ---------------------------------------------------------------
  const pendingByKey = new Map<string, PendingUser>();
  const plans: Plan[] = [];
  for (const person of people) {
    const explicit = decisions.has(person.personKey);
    const decision = decisions.get(person.personKey) ?? defaultDecision(person);
    if (decision.action === 'skip') {
      plans.push({ person, decision, explicit, explicitRoleId: null, roleId: null });
      continue;
    }
    let existing: ActiveUser | undefined;
    let pending: PendingUser | undefined;
    if (decision.action === 'link') {
      existing = decision.userId ? userById.get(decision.userId) : undefined;
      if (!existing) throw new RosterImportError(`"${person.name}" can't be linked: that staff member isn't active at this venue.`);
    } else {
      const name = (decision.name?.trim() || person.name).replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
      const key = personNameKey(name);
      if (!key) throw new RosterImportError(`A name is needed to add "${person.name}".`);
      // Upsert by name: someone with this name is already on staff (a second import, a
      // double-submit, another manager's import that just finished) -> that person.
      existing = userByKey.get(key);
      if (!existing) {
        pending = pendingByKey.get(key) ?? { name, roleId: null };
        pendingByKey.set(key, pending);
      }
    }
    const explicitRoleId = decision.roleName?.trim() ? await roles.ensure(decision.roleName) : null;
    const roleId = explicitRoleId ?? roles.active(person.resolvedRoleId) ?? roles.active(existing?.roleId);
    if (pending && (explicitRoleId || !pending.roleId)) pending.roleId = explicitRoleId ?? pending.roleId ?? roleId;
    plans.push({ person, decision, explicit, existing, pending, explicitRoleId, roleId });
  }

  // Nobody is dropped for want of a role: the venue's "Team member" role until one is assigned.
  let teamMemberRoleId = roles.lookup(TEAM_MEMBER_ROLE_NAME);
  const needsTeamMember = plans.some((p) => p.decision.action !== 'skip' && !p.roleId) || [...pendingByKey.values()].some((p) => !p.roleId);
  if (needsTeamMember) teamMemberRoleId = await roles.ensure(TEAM_MEMBER_ROLE_NAME);
  for (const plan of plans) if (plan.decision.action !== 'skip' && !plan.roleId) plan.roleId = teamMemberRoleId;
  for (const pending of pendingByKey.values()) if (!pending.roleId) pending.roleId = teamMemberRoleId;

  // New staff: one per distinct normalized name, however many entries chose "create" for it.
  const pendings = [...pendingByKey.entries()];
  if (pendings.length > 0) {
    const created = await tx.user.createManyAndReturn({
      data: pendings.map(([, p]) => ({ locationId, fullName: p.name, roleId: p.roleId, systemRole: 'STAFF' as const, isActive: true })),
      select: { id: true, fullName: true },
    });
    const idByKey = new Map(created.map((u) => [personNameKey(u.fullName), u.id]));
    for (const [key, p] of pendings) p.id = idByKey.get(key);
    await tx.auditLog.createMany({
      data: created.map((u) => ({
        locationId,
        actorId: input.actorId,
        action: 'STAFF_CREATED' as const,
        entityType: 'User',
        entityId: u.id,
        note: `Added ${u.fullName} from a roster import`,
      })),
    });
  }

  // Existing staff the manager gave a role, who had none (or only the placeholder), take it.
  const roleUpdates = new Map<string, string>();
  for (const plan of plans) {
    if (!plan.existing || !plan.explicitRoleId) continue;
    const current = plan.existing.roleId;
    if (current !== plan.explicitRoleId && (!current || current === teamMemberRoleId)) roleUpdates.set(plan.existing.id, plan.explicitRoleId);
  }
  for (const [userId, roleId] of roleUpdates) await tx.user.update({ where: { id: userId }, data: { roleId } });

  // Remembered for the next import: a role label the manager assigned by hand, a name they linked.
  for (const plan of plans) {
    const roleUnresolved = plan.person.flags.some((f) => f.kind === 'role_unresolved');
    // Remembered without a trailing number, so "Wine Steward 2" next time resolves too.
    const labelKey = plan.person.roleLabel ? nameKey(plan.person.roleLabel) : '';
    const normalizedLabel = stripRoleOrdinal(labelKey) || labelKey;
    if (input.rememberRoleMappings && plan.explicitRoleId && roleUnresolved && normalizedLabel) {
      await tx.rosterRoleAlias.upsert({
        where: { locationId_normalizedLabel: { locationId, normalizedLabel } },
        create: { locationId, normalizedLabel, roleId: plan.explicitRoleId },
        update: { roleId: plan.explicitRoleId },
      });
    }
    if (plan.explicit && plan.decision.action === 'link' && plan.existing) {
      const normalizedName = personNameKey(plan.person.name);
      if (normalizedName && normalizedName !== personNameKey(plan.existing.fullName)) {
        await tx.rosterNameAlias.upsert({
          where: { locationId_normalizedName: { locationId, normalizedName } },
          create: { locationId, normalizedName, userId: plan.existing.id },
          update: { userId: plan.existing.id },
        });
      }
    }
  }

  // Shifts ----------------------------------------------------------------------------------
  const rowByNumber = new Map(input.rows.map((r) => [r.rowNumber, r]));
  interface PlannedShift {
    plan: Plan;
    row: PreviewRow;
    userId: string;
    date: string;
    start: Date;
    end: Date;
    roleId: string;
  }
  const planned: PlannedShift[] = [];
  let skippedPersonRows = 0;
  for (const plan of plans) {
    const personRows = plan.person.rowNumbers.map((n) => rowByNumber.get(n)).filter((r): r is PreviewRow => !!r);
    if (plan.decision.action === 'skip') {
      skippedPersonRows += personRows.length;
      continue;
    }
    const userId = plan.existing?.id ?? plan.pending?.id;
    if (!userId) throw new Error('roster import: a person has neither an existing nor a new staff record');
    for (const row of personRows) {
      const date = addDaysIso(row.date, input.weekDeltaDays);
      planned.push({
        plan,
        row,
        userId,
        date,
        start: combineDateAndTime(date, row.startTime, tz),
        end: combineDateAndTime(date, row.endTime, tz, row.overnight),
        roleId: plan.explicitRoleId ?? roles.active(row.resolvedRoleId) ?? plan.roleId!,
      });
    }
  }

  // Rota builder v2: every week this import touches is locked (in date order, the order every multi-week writer
  // takes them) before reading what is on the rota, so a grid edit cannot land a shift on one of these
  // person-days between the read below and the write.
  for (const weekStart of [...new Set(planned.map((p) => mondayOfIso(p.date)))].sort()) await lockWeek(tx, locationId, weekStart);

  // What these people already work around those days (cancelled shifts don't count).
  const onRota = new Map<string, { date: string; start: Date; end: Date; ranges: TimeRange[] | null }[]>();
  const knownUserIds = [...new Set(planned.filter((p) => p.plan.existing).map((p) => p.userId))];
  const dates = planned.map((p) => p.date).sort();
  if (knownUserIds.length > 0 && dates.length > 0) {
    const existingShifts = await tx.shift.findMany({
      where: {
        locationId,
        userId: { in: knownUserIds },
        status: { not: 'CANCELLED' },
        date: {
          gte: new Date(`${addDaysIso(dates[0]!, -1)}T00:00:00.000Z`),
          lte: new Date(`${addDaysIso(dates[dates.length - 1]!, 1)}T00:00:00.000Z`),
        },
      },
      select: { userId: true, date: true, startTime: true, endTime: true, ranges: true },
    });
    for (const s of existingShifts) {
      if (!s.userId) continue;
      onRota.set(s.userId, [
        ...(onRota.get(s.userId) ?? []),
        { date: s.date.toISOString().slice(0, 10), start: s.startTime, end: s.endTime, ranges: validateRanges(s.ranges) ? s.ranges : null },
      ]);
    }
  }

  // Leave already on those days. Annual / sick / unpaid leave, and any leave from an approved time-off request,
  // keeps the day: the imported shift is reported back like an overlap. A day off or half day gives way to it.
  const leaveByPersonDay = new Map<string, { id: string; type: LeaveTypeCode; locked: boolean }>();
  if (knownUserIds.length > 0 && dates.length > 0) {
    const leaves = await tx.rotaLeave.findMany({
      where: {
        locationId,
        userId: { in: knownUserIds },
        date: { gte: new Date(`${dates[0]!}T00:00:00.000Z`), lte: new Date(`${dates[dates.length - 1]!}T00:00:00.000Z`) },
      },
      select: { id: true, userId: true, date: true, type: true, timeOffRequestId: true },
    });
    for (const l of leaves) {
      leaveByPersonDay.set(`${l.userId}|${l.date.toISOString().slice(0, 10)}`, {
        id: l.id,
        type: l.type,
        locked: leaveBlocksShifts(l.type) || l.timeOffRequestId !== null,
      });
    }
  }

  const wallClock = (d: Date) => dayjs(d).tz(tz).format('HH:mm');
  const toCreate: PlannedShift[] = [];
  const overlaps: ImportOverlap[] = [];
  let skippedDuplicates = 0;
  const overlapWith = (shift: PlannedShift, existing: { date: string; start: Date; end: Date }) => {
    overlaps.push({
      personKey: shift.plan.person.personKey,
      name: shift.plan.existing?.fullName ?? shift.plan.pending?.name ?? shift.plan.person.name,
      date: shift.date,
      startTime: shift.row.startTime,
      endTime: shift.row.endTime,
      existing: { date: existing.date, startTime: wallClock(existing.start), endTime: wallClock(existing.end) },
    });
  };
  for (const shift of planned) {
    const mine = onRota.get(shift.userId) ?? [];
    // Identical: the same instants, or one range of a (merged, split) shift already on the rota.
    if (
      mine.some(
        (s) =>
          (s.start.getTime() === shift.start.getTime() && s.end.getTime() === shift.end.getTime()) ||
          (s.date === shift.date && s.ranges?.some((r) => r.start === shift.row.startTime && r.end === shift.row.endTime)),
      )
    ) {
      skippedDuplicates++;
      continue;
    }
    const clash = mine.find((s) => s.start < shift.end && shift.start < s.end);
    if (clash) {
      overlapWith(shift, clash);
      continue;
    }
    const leave = leaveByPersonDay.get(`${shift.userId}|${shift.date}`);
    if (leave?.locked) {
      overlaps.push({
        personKey: shift.plan.person.personKey,
        name: shift.plan.existing?.fullName ?? shift.plan.pending?.name ?? shift.plan.person.name,
        date: shift.date,
        startTime: shift.row.startTime,
        endTime: shift.row.endTime,
        existing: { date: shift.date, startTime: '', endTime: '' },
        existingLeave: leave.type,
      });
      continue;
    }
    // Rota builder v2: one live shift per person per day. A second (non-overlapping) shift on a day the
    // person already works is reported like an overlap rather than written — merging into an existing
    // row would silently rewrite a published shift.
    const sameDay = mine.find((s) => s.date === shift.date);
    if (sameDay) {
      overlapWith(shift, sameDay);
      continue;
    }
    mine.push({ date: shift.date, start: shift.start, end: shift.end, ranges: null });
    onRota.set(shift.userId, mine);
    toCreate.push(shift);
  }

  // Rota builder v2 stores a split shift as ONE row with two ranges: two rows of this import on the same
  // person-day become one shift (first start → last end); a third is reported like an overlap.
  interface ShiftRow {
    parts: PlannedShift[];
    userId: string;
    date: string;
    roleId: string;
    start: Date;
    end: Date;
    ranges: TimeRange[];
    endsNextDay: boolean;
  }
  const rowsByPersonDay = new Map<string, ShiftRow>();
  for (const shift of toCreate.slice().sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const key = `${shift.userId}|${shift.date}`;
    const row = rowsByPersonDay.get(key);
    if (!row) {
      rowsByPersonDay.set(key, {
        parts: [shift],
        userId: shift.userId,
        date: shift.date,
        roleId: shift.roleId,
        start: shift.start,
        end: shift.end,
        ranges: [{ start: shift.row.startTime, end: shift.row.endTime }],
        endsNextDay: shift.row.overnight,
      });
      continue;
    }
    const merged = [...row.ranges, { start: shift.row.startTime, end: shift.row.endTime }];
    if (!validateRanges(merged)) {
      overlapWith(shift, { date: row.date, start: row.start, end: row.end });
      continue;
    }
    row.parts.push(shift);
    row.end = shift.end;
    row.ranges = merged;
    row.endsNextDay = shift.row.overnight;
  }
  const shiftRows = [...rowsByPersonDay.values()];
  const publishedAt = new Date();

  // A day off / half day on a person-day that now holds an imported shift goes: a person-day is one or the other.
  const yieldedLeaveIds = shiftRows.map((s) => leaveByPersonDay.get(`${s.userId}|${s.date}`)?.id).filter((id): id is string => id !== undefined);
  if (yieldedLeaveIds.length > 0) await tx.rotaLeave.deleteMany({ where: { id: { in: yieldedLeaveIds } } });

  const createdShifts =
    shiftRows.length > 0
      ? await tx.shift.createManyAndReturn({
          data: shiftRows.map((s) => ({
            locationId,
            roleId: s.roleId,
            userId: s.userId,
            createdById: input.createdById,
            date: new Date(`${s.date}T00:00:00.000Z`),
            startTime: s.start,
            endTime: s.end,
            breakMinutes: s.parts[0]!.row.breakMinutes,
            managerNotes: s.parts[0]!.row.managerNotes,
            status: 'PUBLISHED' as const,
            ranges: s.ranges as unknown as Prisma.InputJsonValue,
            endsNextDay: s.endsNextDay,
            publishedAt,
          })),
          select: { id: true, userId: true, date: true },
        })
      : [];
  // (userId, date) is unique among created shifts: one row per person-day by construction.
  const shiftIdByKey = new Map(createdShifts.map((s) => [`${s.userId}|${s.date.toISOString().slice(0, 10)}`, s.id]));
  const rows = shiftRows.flatMap((s) =>
    s.parts.map((part) => ({
      rowNumber: part.row.rowNumber,
      shiftId: shiftIdByKey.get(`${s.userId}|${s.date}`)!,
      userId: s.userId,
      date: s.date,
    })),
  );

  // Imported rows are PUBLISHED straight away, so every week touched gets its v2 week row created/bumped and
  // the imported rows added to its published snapshot (staff were told these): to the week grid's publish diff
  // they are published, while a manager's drafts in the same week still wait for Publish.
  const createdIdsByWeek = new Map<string, string[]>();
  for (const s of createdShifts) {
    const weekStart = mondayOfIso(s.date.toISOString().slice(0, 10));
    createdIdsByWeek.set(weekStart, [...(createdIdsByWeek.get(weekStart) ?? []), s.id]);
  }
  for (const weekStart of [...createdIdsByWeek.keys()].sort()) {
    await snapshotWeek(tx, locationId, weekStart, { publishedById: input.actorId, publishedAt, mergeShiftIds: createdIdsByWeek.get(weekStart)! });
  }

  // Shifts created per person: every import row that became (part of) a written shift counts once.
  const createdPerPerson = new Map<string, number>();
  for (const s of shiftRows) for (const part of s.parts) createdPerPerson.set(part.plan.person.personKey, (createdPerPerson.get(part.plan.person.personKey) ?? 0) + 1);

  // Two entries creating the same name share one new staff member: the first counts as created.
  const countedAsCreated = new Set<string>();
  const confirmedPeople: ConfirmedPerson[] = plans.map((plan) => {
    const userId = plan.existing?.id ?? plan.pending?.id ?? null;
    let outcome: ConfirmedPerson['outcome'] = 'linked';
    if (plan.decision.action === 'skip') outcome = 'skipped';
    else if (plan.pending && userId && !countedAsCreated.has(userId)) {
      outcome = 'created';
      countedAsCreated.add(userId);
    }
    const roleId = plan.decision.action === 'skip' ? null : (plan.explicitRoleId ?? plan.roleId);
    return {
      personKey: plan.person.personKey,
      name: plan.existing?.fullName ?? plan.pending?.name ?? plan.person.name,
      outcome,
      userId,
      roleName: roleId ? (roles.nameById.get(roleId) ?? null) : null,
      shiftsCreated: createdPerPerson.get(plan.person.personKey) ?? 0,
    };
  });

  const firstDate = dates[0];
  return {
    createdPeople: countedAsCreated.size,
    // Distinct existing staff (two entries linked to one person count once).
    linkedPeople: new Set(confirmedPeople.filter((p) => p.outcome === 'linked' && p.userId && !countedAsCreated.has(p.userId)).map((p) => p.userId)).size,
    skippedPeople: confirmedPeople.filter((p) => p.outcome === 'skipped').length,
    createdShifts: rows.length,
    skippedDuplicates,
    overlaps,
    people: confirmedPeople,
    weekStart: firstDate ? mondayOfIso(firstDate) : null,
    rows,
    skippedRowCount: skippedPersonRows + skippedDuplicates + overlaps.length,
  };
}
