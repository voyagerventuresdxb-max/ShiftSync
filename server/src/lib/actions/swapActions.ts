import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { isRequestLocked, nextRequestWindowClose } from '../swapRequestPolicy.js';
import { writeAuditLog } from '../auditLog.js';

/**
 * The Prisma `include` every swap-request read uses. Kept in one place so the
 * list/create/decide paths (route handlers in `routes/swapRequests.ts`, plus
 * the actions below) can never drift apart on which relation fields the
 * route's `toDto` is allowed to read.
 */
export const SWAP_REQUEST_INCLUDE = {
  requestedBy: { select: { fullName: true } },
  targetUser: { select: { fullName: true } },
  shift: { select: { userId: true, date: true, startTime: true, endTime: true } },
} as const;

export type SwapRequestWithRelations = Prisma.ShiftSwapRequestGetPayload<{
  include: typeof SWAP_REQUEST_INCLUDE;
}>;

/**
 * Thrown inside the decide transaction when the atomic `shift.updateMany`
 * guard finds the shift's owner no longer matches `requestedById` — i.e. a
 * different request already reassigned this shift between our initial read
 * and this write. Thrown (rather than just returning a flag) so the
 * transaction rolls back the status/audit writes too, instead of leaving a
 * false "approved" record with no matching reassignment.
 */
export class ShiftAlreadyReassignedError extends Error {}

/** Creates a PENDING cover-swap request. Mirrors the POST /api/swap-requests body shape. */
export async function createSwapRequest(input: {
  shiftId: string;
  requestedById: string;
  targetUserId: string;
  reason: string | null;
}): Promise<SwapRequestWithRelations> {
  return prisma.shiftSwapRequest.create({
    data: {
      shiftId: input.shiftId,
      requestedById: input.requestedById,
      targetUserId: input.targetUserId,
      type: 'COVER',
      status: 'PENDING',
      reason: input.reason,
      expiresAt: nextRequestWindowClose(),
    },
    include: SWAP_REQUEST_INCLUDE,
  });
}

/**
 * Approves or declines a pending swap request. On approval, atomically
 * reassigns the shift to the target user — guarded against a TOCTOU race
 * where a different already-approved request reassigned the same shift
 * first (see `ShiftAlreadyReassignedError`).
 */
export async function decideSwapRequest(input: {
  id: string;
  decision: 'approved' | 'declined';
  reviewedById: string | null;
}): Promise<
  | { result: 'ok'; request: SwapRequestWithRelations }
  | { result: 'not_found' }
  | { result: 'conflict' }
> {
  const existing = await prisma.shiftSwapRequest.findUnique({
    where: { id: input.id },
    include: { requestedBy: { select: { fullName: true } }, targetUser: { select: { fullName: true } }, shift: true },
  });
  if (!existing) return { result: 'not_found' };

  if (isRequestLocked({ status: existing.status }, { userId: existing.shift.userId }, existing.requestedById)) {
    return { result: 'conflict' };
  }

  const status = input.decision === 'approved' ? 'APPROVED' : 'DECLINED';
  const managerNote =
    input.decision === 'approved'
      ? `Approved · shift reassigned to ${existing.targetUser?.fullName ?? 'the proposed cover'}`
      : 'Declined';

  const updated = await prisma
    .$transaction(async (tx) => {
      // Atomic guard: only reassign the shift if it is still owned by the
      // same user who requested the swap. This is the real source of truth
      // against the TOCTOU race — two managers approving two different
      // pending requests for the same shift can both pass the earlier
      // informational `isRequestLocked` check (which only reflects what was
      // true at read time), but only one `updateMany` here can ever match
      // and actually flip `userId`.
      if (input.decision === 'approved' && existing.targetUserId) {
        const reassigned = await tx.shift.updateMany({
          where: { id: existing.shiftId, userId: existing.requestedById },
          data: { userId: existing.targetUserId },
        });
        if (reassigned.count === 0) {
          // Someone else's approval already moved this shift out from under
          // the original requester. Throwing here rolls back the whole
          // transaction, so we do NOT let the status/audit writes below
          // stand as if this approval had actually happened.
          throw new ShiftAlreadyReassignedError();
        }
      }

      const updatedRequest = await tx.shiftSwapRequest.update({
        where: { id: input.id },
        data: { status, reviewedById: input.reviewedById, reviewedAt: new Date(), managerNote },
        include: SWAP_REQUEST_INCLUDE,
      });

      await writeAuditLog(tx, {
        locationId: existing.shift.locationId,
        actorId: input.reviewedById,
        shiftId: existing.shiftId,
        action: input.decision === 'approved' ? 'SWAP_APPROVED' : 'SWAP_DECLINED',
        entityType: 'ShiftSwapRequest',
        entityId: input.id,
        note: managerNote,
      });

      return updatedRequest;
    })
    .catch((err) => {
      if (err instanceof ShiftAlreadyReassignedError) return null;
      throw err;
    });

  if (!updated) return { result: 'conflict' };
  return { result: 'ok', request: updated };
}
