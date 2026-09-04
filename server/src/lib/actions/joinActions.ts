import { prisma } from '../prisma.js';
import { writeAuditLog } from '../auditLog.js';

/**
 * Thrown inside the decide transactions (both decline and approve) when the
 * atomic `joinRequest.updateMany` guard finds the request is no longer
 * PENDING — i.e. a concurrent decision (a double-approve, or an
 * approve/decline race on the same request) already reviewed it between our
 * initial read and this write. Thrown (rather than just returning a flag) so
 * the transaction rolls back the rest of what it was about to write too —
 * on the approve path that includes the just-created User row, so a losing
 * race never leaves an orphan staff member with no matching "approved"
 * request. Mirrors `swapActions.ts`'s `ShiftAlreadyReassignedError`.
 */
export class JoinRequestAlreadyReviewedError extends Error {}

/**
 * Approves or declines a PENDING join request.
 *
 * Approving creates a real, active User from the request's phone/fullName
 * and links it back onto the request — this is the one place a JoinRequest
 * ever produces a real staff member. `decision` and `jobTitle` are assumed
 * already parsed/validated by the caller (the HTTP route, or a future voice
 * caller).
 */
export async function decideJoinRequest(input: {
  requestId: string;
  decision: 'approve' | 'decline';
  reviewedById: string | null;
  jobTitle?: string | null;
}): Promise<
  | { result: 'ok'; status: 'APPROVED' | 'DECLINED'; userId?: string }
  | { result: 'not_found' }
  | { result: 'already_reviewed' }
> {
  const existing = await prisma.joinRequest.findUnique({ where: { id: input.requestId } });
  if (!existing) return { result: 'not_found' };
  if (existing.status !== 'PENDING') return { result: 'already_reviewed' };

  if (input.decision === 'decline') {
    const declined = await prisma
      .$transaction(async (tx) => {
        // Atomic guard: only decline if the request is still PENDING. Two
        // concurrent decisions on the same request (double-decline, or an
        // approve/decline race) can both pass the plain `existing.status`
        // check above (which only reflects what was true at read time), but
        // only one `updateMany` here can ever match and actually flip status.
        const result = await tx.joinRequest.updateMany({
          where: { id: input.requestId, status: 'PENDING' },
          data: { status: 'DECLINED', reviewedById: input.reviewedById, reviewedAt: new Date() },
        });
        if (result.count === 0) {
          throw new JoinRequestAlreadyReviewedError();
        }
        await writeAuditLog(tx, {
          locationId: existing.locationId,
          actorId: input.reviewedById,
          action: 'JOIN_DECLINED',
          entityType: 'JoinRequest',
          entityId: input.requestId,
          note: `Declined join request for ${existing.fullName}`,
        });
        return true;
      })
      .catch((err) => {
        if (err instanceof JoinRequestAlreadyReviewedError) return null;
        throw err;
      });
    if (!declined) return { result: 'already_reviewed' };
    return { result: 'ok', status: 'DECLINED' };
  }

  const jobTitle = input.jobTitle ?? null;
  const created = await prisma
    .$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { locationId: existing.locationId, fullName: existing.fullName, phone: existing.phone, jobTitle },
      });
      // Same atomic guard as the decline branch above. If this loses the
      // race, throwing rolls back the `user.create` too, so a losing
      // approval never leaves an orphan User with no matching approved
      // request.
      const result = await tx.joinRequest.updateMany({
        where: { id: input.requestId, status: 'PENDING' },
        data: { status: 'APPROVED', reviewedById: input.reviewedById, reviewedAt: new Date(), createdUserId: user.id },
      });
      if (result.count === 0) {
        throw new JoinRequestAlreadyReviewedError();
      }
      await writeAuditLog(tx, {
        locationId: existing.locationId,
        actorId: input.reviewedById,
        action: 'JOIN_APPROVED',
        entityType: 'JoinRequest',
        entityId: input.requestId,
        note: `Approved join request for ${existing.fullName} — created User ${user.id}`,
      });
      return user;
    })
    .catch((err) => {
      if (err instanceof JoinRequestAlreadyReviewedError) return null;
      throw err;
    });
  if (!created) return { result: 'already_reviewed' };
  return { result: 'ok', status: 'APPROVED', userId: created.id };
}
