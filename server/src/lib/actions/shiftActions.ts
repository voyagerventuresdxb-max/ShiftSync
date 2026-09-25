import type { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { prisma } from '../prisma.js';
import { withAuditedTransaction, writeAuditLog } from '../auditLog.js';
import { notifyUser } from '../push.js';
import { formatVenueTime, venueTimezoneFor } from '../venueTime.js';

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

/**
 * Raw create — exactly the `tx.shift.create(...)` call
 * `routes/shifts.ts`'s `POST /` made inline before this extraction.
 * Validation (role/user existence, same-location membership, date/time
 * shape) is the CALLER's responsibility, not this function's — mirrors
 * `lib/actions/swapActions.ts`'s `createSwapRequest`, which is the
 * established precedent for this split in this codebase.
 */
export async function createShift(
  data: Prisma.ShiftCreateInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ShiftWithRelations> {
  return client.shift.create({ data, include: SHIFT_INCLUDE });
}

/** Raw update — exactly the `tx.shift.update(...)` call `PATCH /:id` made inline before this extraction. Same validate-in-caller split as `createShift`. */
export async function updateShift(
  id: string,
  data: Prisma.ShiftUpdateInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ShiftWithRelations> {
  return client.shift.update({ where: { id }, data, include: SHIFT_INCLUDE });
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

/**
 * The one way a shift is edited after creation — REST PATCH /api/shifts/:id
 * and voice EDIT_SHIFT both go through here, so both write the same
 * SHIFT_UPDATED audit row AND both notify staff when a PUBLISHED shift
 * changes. Validation stays with the caller (same split as createShift).
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
      return { before, updated: await updateShift(input.id, input.data, tx) };
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
