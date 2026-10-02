import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { withAuditedTransaction } from '../auditLog.js';
import { notifyUser } from '../push.js';

export const JOIN_PHONE_TAKEN_ERROR = "This phone number already belongs to another staff account, so this request can't be approved. Decline it instead.";

/** What a declined applicant sees, from /login or from the venue's join link. */
export function joinDeclinedMessage(venueName: string): string {
  return `Your request to join ${venueName} was declined. If that's a mistake, ask a manager there to add you to the staff list, then sign in with this number.`;
}

/** Exact-target P2002 on `User.phone`, same check as staffDirectory.ts's `isPhoneConflict`. */
function isPhoneConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target as unknown;
  return Array.isArray(target) && target.length === 1 && target[0] === 'phone';
}

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
  | { result: 'phone_taken' }
> {
  const existing = await prisma.joinRequest.findUnique({
    where: { id: input.requestId },
    include: { location: { select: { name: true } } },
  });
  if (!existing) return { result: 'not_found' };
  if (existing.status !== 'PENDING') return { result: 'already_reviewed' };

  if (input.decision === 'decline') {
    const declined = await withAuditedTransaction(
      prisma,
      async (tx) => {
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
        return true;
      },
      () => ({
        locationId: existing.locationId,
        actorId: input.reviewedById,
        action: 'JOIN_DECLINED',
        entityType: 'JoinRequest',
        entityId: input.requestId,
        note: `Declined join request for ${existing.fullName}`,
      }),
    ).catch((err) => {
      if (err instanceof JoinRequestAlreadyReviewedError) return null;
      throw err;
    });
    if (!declined) return { result: 'already_reviewed' };
    return { result: 'ok', status: 'DECLINED' };
  }

  const jobTitle = input.jobTitle ?? null;
  const created = await withAuditedTransaction(
    prisma,
    async (tx) => {
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
      return user;
    },
    (user) => ({
      locationId: existing.locationId,
      actorId: input.reviewedById,
      action: 'JOIN_APPROVED',
      entityType: 'JoinRequest',
      entityId: input.requestId,
      note: `Approved join request for ${existing.fullName} — created User ${user.id}`,
    }),
  ).catch((err) => {
    if (err instanceof JoinRequestAlreadyReviewedError) return 'already_reviewed' as const;
    // `User.phone` is globally unique, deactivated users included; the insert itself is the race-safe check.
    if (isPhoneConflict(err)) return 'phone_taken' as const;
    throw err;
  });
  if (created === 'phone_taken') {
    // A concurrent approval of this same request collides on the phone too; that one is "already reviewed".
    const current = await prisma.joinRequest.findUnique({ where: { id: input.requestId }, select: { status: true } });
    return { result: current?.status === 'PENDING' ? 'phone_taken' : 'already_reviewed' };
  }
  if (created === 'already_reviewed') return { result: created };
  void notifyUser(created.id, {
    title: "You're in",
    body: `${existing.location.name} approved your request — welcome!`,
    url: '/my-shifts',
  });
  return { result: 'ok', status: 'APPROVED', userId: created.id };
}
