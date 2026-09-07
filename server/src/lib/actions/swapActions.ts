import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { prisma } from '../prisma.js';
import { isRequestLocked, nextRequestWindowClose } from '../swapRequestPolicy.js';
import { withAuditedTransaction } from '../auditLog.js';
import { notifyUser } from '../push.js';
import { getManagerIdsForLocation } from '../managers.js';

dayjs.extend(utc);

/**
 * Human-readable shift label, e.g. "Mon 25 Aug · 09:00–17:00". Formatted in
 * UTC (same rationale as `parsing/normalize.ts`): the stored wall-clock
 * date/time is what matters, not how the server's local timezone happens to
 * render it. Shared by routes/swapRequests.ts's DTO and the notification
 * copy below, so the request list and its notifications never describe the
 * same shift differently.
 */
export function shiftLabelOf(shift: { date: Date; startTime: Date; endTime: Date }): string {
  const day = dayjs.utc(shift.date).format('ddd D MMM');
  const start = dayjs.utc(shift.startTime).format('HH:mm');
  const end = dayjs.utc(shift.endTime).format('HH:mm');
  return `${day} · ${start}–${end}`;
}

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

/**
 * Creates a PENDING cover-swap request. Mirrors the POST /api/swap-requests
 * body shape. Accepts either the top-level `prisma` client or a `tx` — a
 * caller that writes an accompanying audit-log row (routes/swapRequests.ts,
 * routes/voice.ts's REQUEST_SWAP) passes `tx` so both commit atomically.
 */
export async function createSwapRequest(
  input: {
    shiftId: string;
    requestedById: string;
    targetUserId: string;
    reason: string | null;
  },
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SwapRequestWithRelations> {
  return client.shiftSwapRequest.create({
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
    // Reuses SWAP_REQUEST_INCLUDE's own requestedBy/targetUser selects
    // (rather than retyping them) so there's only one place that says "which
    // fields does a swap-request read need" for those two relations — only
    // `shift` differs here: just userId (the TOCTOU guard) and locationId
    // (the audit entry) are read below, so a narrower select replaces
    // SWAP_REQUEST_INCLUDE's own shift shape (date/startTime/endTime, needed
    // for the DTO this function does NOT return) instead of a full
    // `shift: true` (found by the 2026-09-05 performance audit; the
    // duplication risk of hand-rolling all three relations separately was
    // caught by its mandatory review).
    include: {
      requestedBy: SWAP_REQUEST_INCLUDE.requestedBy,
      targetUser: SWAP_REQUEST_INCLUDE.targetUser,
      shift: { select: { userId: true, locationId: true } },
    },
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

  const updated = await withAuditedTransaction(
    prisma,
    async (tx) => {
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

      return updatedRequest;
    },
    () => ({
      locationId: existing.shift.locationId,
      actorId: input.reviewedById,
      shiftId: existing.shiftId,
      action: input.decision === 'approved' ? 'SWAP_APPROVED' : 'SWAP_DECLINED',
      entityType: 'ShiftSwapRequest',
      entityId: input.id,
      note: managerNote,
    }),
  ).catch((err) => {
    if (err instanceof ShiftAlreadyReassignedError) return null;
    throw err;
  });

  if (!updated) return { result: 'conflict' };
  return { result: 'ok', request: updated };
}

/**
 * Notifies every manager at the location that a new cover request needs
 * review. Shared by routes/swapRequests.ts's POST and routes/voice.ts's
 * REQUEST_SWAP — both create requests via createSwapRequest above and must
 * not develop two different notification behaviors. Callers invoke this
 * AFTER their own transaction commits (never inside one — a push failure
 * must not roll back the request itself), which is why this takes the
 * already-created request rather than creating one itself.
 */
export async function notifySwapRequested(request: SwapRequestWithRelations, locationId: string): Promise<void> {
  const managerIds = await getManagerIdsForLocation(locationId);
  const coveringName = request.targetUser?.fullName ?? 'a colleague';
  const label = shiftLabelOf(request.shift);
  await Promise.all(
    managerIds.map((managerId) =>
      notifyUser(managerId, {
        title: 'New swap request',
        body: `${request.requestedBy.fullName} asked ${coveringName} to cover their shift, ${label}.`,
        url: '/',
      }),
    ),
  );
}

/**
 * Notifies the original requester (always) and, on approval, the covering
 * staff member — they're getting a shift they never asked for, so that
 * notification says so explicitly rather than reusing generic "schedule
 * updated" copy. Shared by routes/swapRequests.ts's PATCH and
 * routes/voice.ts's APPROVE_SWAP/DECLINE_SWAP, called after their
 * transaction commits, same rationale as notifySwapRequested above.
 */
export async function notifySwapDecided(request: SwapRequestWithRelations, decision: 'approved' | 'declined'): Promise<void> {
  const label = shiftLabelOf(request.shift);
  if (decision === 'approved') {
    await notifyUser(request.requestedById, {
      title: 'Swap request approved',
      body: `Your swap request for ${label} was approved — ${request.targetUser?.fullName ?? 'your colleague'} will cover it.`,
      url: '/my-shifts',
    });
    if (request.targetUserId) {
      await notifyUser(request.targetUserId, {
        title: 'You were added to a shift',
        body: `${request.requestedBy.fullName} asked you to cover their shift, ${label}, and it's been approved — this shift is now on your schedule.`,
        url: '/my-shifts',
      });
    }
  } else {
    await notifyUser(request.requestedById, {
      title: 'Swap request declined',
      body: `Your swap request for ${label} was declined.`,
      url: '/my-shifts',
    });
  }
}
