import type { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { prisma } from '../prisma.js';
import { withAuditedTransaction, writeAuditLog } from '../auditLog.js';
import { notifyUser } from '../push.js';
import { formatVenueTime, venueTimezoneFor } from '../venueTime.js';
import { DEFAULT_VENUE_TIMEZONE } from '../../parsing/normalize.js';

dayjs.extend(utc);

/**
 * The Prisma `include` every shift read/write uses. Moved here from
 * routes/shifts.ts so routes/voice.ts's CREATE_SHIFT/EDIT_SHIFT cases can
 * share it instead of redefining the shape.
 */
export const SHIFT_INCLUDE = {
  assignee: { select: { id: true, fullName: true } },
  role: { select: { id: true, name: true } },
} as const;

export type ShiftWithRelations = Prisma.ShiftGetPayload<{ include: typeof SHIFT_INCLUDE }>;

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Thrown by createShift/editShift when the person already has a shift that
 * overlaps the new times (split shifts, 2026-10-02). Input validation, not a
 * compliance rule — every caller answers it with a 409 `{ error: message }`.
 */
export class ShiftOverlapError extends Error {}

/**
 * The database-level half of the rule (migration
 * 20261003140000_shift_no_overlap_per_user): an EXCLUDE constraint on
 * (user_id, [start_time, end_time)) for non-CANCELLED shifts. The app-level
 * `findShiftOverlap` check runs first for a friendly message, but two
 * concurrent writes can both pass it; the constraint is what makes exactly
 * one of them win. Its violation surfaces from Prisma as a request error
 * naming the constraint; every writer maps it to ShiftOverlapError.
 */
export const SHIFT_OVERLAP_CONSTRAINT = 'shifts_no_overlap_per_user';
export const DB_OVERLAP_MESSAGE = 'This person already has a shift at that time — two shifts for one person can\'t overlap.';

export function isShiftOverlapViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.message} ${(err as { meta?: { message?: string } }).meta?.message ?? ''}`;
  return text.includes(SHIFT_OVERLAP_CONSTRAINT);
}

/** Runs a shift write, turning a constraint violation into the same 409 every caller already handles. */
export async function guardingOverlap<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isShiftOverlapViolation(err)) throw new ShiftOverlapError(DB_OVERLAP_MESSAGE);
    throw err;
  }
}

// Through `client`, never the global pool: inside a transaction that would wait on the connection the transaction holds.
async function timezoneOf(locationId: string, client: Client): Promise<string> {
  const location = await client.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  return location?.timezone || DEFAULT_VENUE_TIMEZONE;
}

/** The message every overlap refusal returns, so REST, bulk, templates, voice and swaps all say the same thing. */
export function overlapMessage(fullName: string | null | undefined, date: string, start: string, end: string): string {
  return `${fullName ?? 'This staff member'} already works ${start}–${end} on ${date} — two shifts for one person can't overlap.`;
}

/**
 * The refusal message if `userId` already has a shift overlapping
 * [startTime, endTime), else null. Compared as instants, so an overnight
 * segment running into the next day counts; segments that only touch
 * (15:00 end, 15:00 start) don't. CANCELLED shifts and `excludeId` (the
 * shift being edited) are ignored.
 */
export async function findShiftOverlap(
  input: { userId: string; startTime: Date; endTime: Date; excludeId?: string },
  client: Client = prisma,
): Promise<string | null> {
  const clash = await client.shift.findFirst({
    where: {
      userId: input.userId,
      status: { not: 'CANCELLED' },
      startTime: { lt: input.endTime },
      endTime: { gt: input.startTime },
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
    orderBy: { startTime: 'asc' },
    include: { assignee: { select: { fullName: true } } },
  });
  if (!clash) return null;
  const timezone = await timezoneOf(clash.locationId, client);
  return overlapMessage(
    clash.assignee?.fullName,
    clash.date.toISOString().slice(0, 10),
    formatVenueTime(clash.startTime, timezone),
    formatVenueTime(clash.endTime, timezone),
  );
}

/**
 * Same rule for a batch about to be written in one go (bulk create / copy
 * last week, template apply): the first person who would end up with
 * overlapping shifts — against what's stored or another row of the batch —
 * as a refusal message, else null. One query, however many rows.
 */
export async function findBatchOverlap(
  locationId: string,
  rows: { userId: string | null; date: string; startTime: Date; endTime: Date }[],
  client: Client = prisma,
): Promise<string | null> {
  const assigned = rows.filter((r): r is typeof r & { userId: string } => Boolean(r.userId));
  if (assigned.length === 0) return null;
  const stored = await client.shift.findMany({
    where: {
      userId: { in: [...new Set(assigned.map((r) => r.userId))] },
      status: { not: 'CANCELLED' },
      startTime: { lt: new Date(Math.max(...assigned.map((r) => r.endTime.getTime()))) },
      endTime: { gt: new Date(Math.min(...assigned.map((r) => r.startTime.getTime()))) },
    },
    select: { userId: true, date: true, startTime: true, endTime: true },
  });
  const seen = stored.map((s) => ({ userId: s.userId!, date: s.date.toISOString().slice(0, 10), startTime: s.startTime, endTime: s.endTime }));
  for (const r of assigned) {
    const clash = seen.find((s) => s.userId === r.userId && s.startTime < r.endTime && s.endTime > r.startTime);
    if (clash) {
      const timezone = await timezoneOf(locationId, client);
      const user = await client.user.findUnique({ where: { id: r.userId }, select: { fullName: true } });
      return overlapMessage(user?.fullName, clash.date, formatVenueTime(clash.startTime, timezone), formatVenueTime(clash.endTime, timezone));
    }
    seen.push(r);
  }
  return null;
}

async function assertNoOverlap(input: Parameters<typeof findShiftOverlap>[0], client: Client): Promise<void> {
  const message = await findShiftOverlap(input, client);
  if (message) throw new ShiftOverlapError(message);
}

/**
 * Raw create — exactly the `tx.shift.create(...)` call
 * `routes/shifts.ts`'s `POST /` made inline before this extraction.
 * Validation (role/user existence, same-location membership, date/time
 * shape) is the CALLER's responsibility, not this function's — mirrors
 * `lib/actions/swapActions.ts`'s `createSwapRequest`, which is the
 * established precedent for this split in this codebase. The one exception
 * is overlap (throws ShiftOverlapError), so REST POST and voice CREATE_SHIFT
 * can never disagree on it.
 */
export async function createShift(
  data: Prisma.ShiftCreateInput,
  client: Client = prisma,
): Promise<ShiftWithRelations> {
  // Callers pass the unchecked shape (userId, not an `assignee` relation).
  const { userId, startTime, endTime } = data as unknown as { userId?: string | null; startTime: Date | string; endTime: Date | string };
  if (userId) await assertNoOverlap({ userId, startTime: new Date(startTime), endTime: new Date(endTime) }, client);
  return guardingOverlap(() => client.shift.create({ data, include: SHIFT_INCLUDE }));
}

/** Raw update — exactly the `tx.shift.update(...)` call `PATCH /:id` made inline before this extraction. Same validate-in-caller split as `createShift`. */
export async function updateShift(
  id: string,
  data: Prisma.ShiftUpdateInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ShiftWithRelations> {
  return guardingOverlap(() => client.shift.update({ where: { id }, data, include: SHIFT_INCLUDE }));
}

type ShiftSnapshot = Pick<ShiftWithRelations, 'id' | 'locationId' | 'userId' | 'status' | 'date' | 'startTime' | 'endTime' | 'roleId' | 'managerNotes' | 'sidework'>;

/** "Tue 22 Sep · 18:00–23:30", in the venue's own timezone (a Dubai shift reads as Dubai time on every device). */
function labelOf(shift: Pick<ShiftSnapshot, 'date' | 'startTime' | 'endTime'>, timezone: string): string {
  const day = dayjs.utc(shift.date).format('ddd D MMM');
  return `${day} · ${formatVenueTime(shift.startTime, timezone)}–${formatVenueTime(shift.endTime, timezone)}`;
}

/**
 * Tells the affected staff member(s) that a PUBLISHED shift changed under
 * them (golden-path v0, 2026-09-25: published-week edits stay live, so the
 * person has to hear about it). A DRAFT shift notifies no one — nobody has
 * seen it yet. `after === null` means the shift was deleted. Reassignment
 * notifies both sides: the old assignee loses it, the new one gains it.
 * Runs after the write has committed (never inside the transaction — a push
 * failure must not roll back the edit), same as swapActions' notifiers.
 */
export async function notifyPublishedShiftChange(before: ShiftSnapshot, after: ShiftSnapshot | null): Promise<void> {
  if (before.status !== 'PUBLISHED') return;
  const timezone = await venueTimezoneFor(before.locationId);
  const was = labelOf(before, timezone);
  const sends: Promise<void>[] = [];

  if (!after) {
    if (before.userId) {
      sends.push(notifyUser(before.userId, { title: 'Shift removed', body: `Your shift on ${was} was removed.`, url: '/my-shifts' }));
    }
    await Promise.all(sends);
    return;
  }

  // Moved into a week that isn't published: it went back to DRAFT
  // (editShift), so for the staff member it's gone — same "removed" message.
  if (after.status !== 'PUBLISHED') {
    if (before.userId) {
      sends.push(notifyUser(before.userId, { title: 'Shift removed', body: `Your shift on ${was} was removed.`, url: '/my-shifts' }));
    }
    await Promise.all(sends);
    return;
  }

  const now = labelOf(after, timezone);
  if (before.userId !== after.userId) {
    if (before.userId) {
      sends.push(notifyUser(before.userId, { title: 'Shift removed', body: `Your shift on ${was} was removed.`, url: '/my-shifts' }));
    }
    if (after.userId) {
      sends.push(notifyUser(after.userId, { title: 'You were added to a shift', body: `You're now on ${now}.`, url: '/my-shifts' }));
    }
  } else if (after.userId) {
    const timesChanged = was !== now;
    const detailsChanged =
      before.roleId !== after.roleId || before.managerNotes !== after.managerNotes || before.sidework.join('\n') !== after.sidework.join('\n');
    if (timesChanged) {
      sends.push(notifyUser(after.userId, { title: 'Shift changed', body: `Your shift on ${was} is now ${now}.`, url: '/my-shifts' }));
    } else if (detailsChanged) {
      sends.push(notifyUser(after.userId, { title: 'Shift updated', body: `The details of your shift on ${now} were updated.`, url: '/my-shifts' }));
    }
  }
  await Promise.all(sends);
}

function notifyInBackground(before: ShiftSnapshot, after: ShiftSnapshot | null): void {
  void notifyPublishedShiftChange(before, after).catch((err) => console.error('[shiftActions] change notification failed', before.id, err));
}

/** Monday (UTC date) of the week containing a `@db.Date` value — the key RotaPublish rows use. */
function weekStartOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

/**
 * The one way a shift is edited after creation — REST PATCH /api/shifts/:id
 * and voice EDIT_SHIFT both go through here, so both write the same
 * SHIFT_UPDATED audit row AND both notify staff when a PUBLISHED shift
 * changes. Validation stays with the caller (same split as createShift).
 *
 * A shift takes the publish state of the week it lives in (2026-09-25): a
 * PUBLISHED shift moved into a week that has never been published goes back
 * to DRAFT (its staff member is told it was removed); moved into a published
 * week it stays live. A DRAFT shift stays DRAFT wherever it moves — nobody
 * has reviewed it, so it is never auto-published.
 *
 * A new person or new times must not overlap another of that person's
 * shifts (throws ShiftOverlapError; split shifts, 2026-10-02).
 */
export async function editShift(input: {
  id: string;
  data: Prisma.ShiftUpdateInput;
  audit: { locationId: string; actorId: string | null; note?: string };
}): Promise<ShiftWithRelations> {
  // `before` is read inside the same transaction as the write, so the
  // notification compares against exactly the row this edit replaced.
  const { before, updated } = await withAuditedTransaction(
    prisma,
    async (tx) => {
      const before = await tx.shift.findUniqueOrThrow({ where: { id: input.id } });
      const data = { ...input.data };
      const next = data as unknown as { userId?: string | null; startTime?: Date; endTime?: Date };
      const nextUserId = next.userId !== undefined ? next.userId : before.userId;
      if (nextUserId && (next.userId !== undefined || next.startTime || next.endTime)) {
        await assertNoOverlap(
          { userId: nextUserId, startTime: next.startTime ?? before.startTime, endTime: next.endTime ?? before.endTime, excludeId: before.id },
          tx,
        );
      }
      const nextDate = data.date instanceof Date ? data.date : typeof data.date === 'string' ? new Date(data.date) : null;
      if (before.status === 'PUBLISHED' && nextDate && weekStartOf(nextDate).getTime() !== weekStartOf(before.date).getTime()) {
        const targetWeekPublished = await tx.rotaPublish.findUnique({
          where: { locationId_weekStart: { locationId: before.locationId, weekStart: weekStartOf(nextDate) } },
          select: { id: true },
        });
        if (!targetWeekPublished) data.status = 'DRAFT';
      }
      return { before, updated: await updateShift(input.id, data, tx) };
    },
    () => ({ ...input.audit, shiftId: input.id, action: 'SHIFT_UPDATED', entityType: 'Shift', entityId: input.id }),
  );
  notifyInBackground(before, updated);
  return updated;
}

/** The one way a shift is deleted — audit-before-delete in one transaction, then "your shift was removed" if it was PUBLISHED. */
export async function removeShift(input: { id: string; audit: { locationId: string; actorId: string | null } }): Promise<void> {
  const before = await withAuditedTransaction(
    prisma,
    async (tx) => {
      const before = await tx.shift.findUniqueOrThrow({ where: { id: input.id } });
      // Audit-before-delete: the row is written while the shift still exists;
      // `shiftId: null` because the FK would be nulled by the delete anyway.
      await writeAuditLog(tx, { ...input.audit, shiftId: null, action: 'SHIFT_DELETED', entityType: 'Shift', entityId: input.id });
      await tx.shift.delete({ where: { id: input.id } });
      return before;
    },
    () => null,
  );
  notifyInBackground(before, null);
}
