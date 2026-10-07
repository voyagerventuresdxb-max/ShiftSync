import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { writeAuditLog, withAuditedTransaction } from '../auditLog.js';

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

/**
 * Removes a shift, audit row first — exactly what `routes/shifts.ts`'s `DELETE /:id` did inline
 * before this extraction, now shared with voice's CANCEL_SHIFT. The audit row is written inside
 * the same transaction, before the delete (its `shiftId` is null: the shift is gone after). Venue
 * ownership and any other checks are the caller's, as for `createShift`.
 */
export async function deleteShift(
  input: { id: string; locationId: string; actorId: string; note?: string | null },
  client: typeof prisma = prisma,
): Promise<void> {
  await withAuditedTransaction(
    client,
    async (tx) => {
      await writeAuditLog(tx, { locationId: input.locationId, actorId: input.actorId, shiftId: null, action: 'SHIFT_DELETED', entityType: 'Shift', entityId: input.id, ...(input.note ? { note: input.note } : {}) });
      await tx.shift.delete({ where: { id: input.id } });
    },
    () => null,
  );
}
