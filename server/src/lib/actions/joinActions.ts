import { prisma } from '../prisma.js';
import { writeAuditLog } from '../auditLog.js';

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
    await prisma.joinRequest.update({
      where: { id: input.requestId },
      data: { status: 'DECLINED', reviewedById: input.reviewedById, reviewedAt: new Date() },
    });
    await writeAuditLog(prisma, {
      locationId: existing.locationId,
      actorId: input.reviewedById,
      action: 'JOIN_DECLINED',
      entityType: 'JoinRequest',
      entityId: input.requestId,
      note: `Declined join request for ${existing.fullName}`,
    });
    return { result: 'ok', status: 'DECLINED' };
  }

  const jobTitle = input.jobTitle ?? null;
  const created = await prisma.user.create({
    data: { locationId: existing.locationId, fullName: existing.fullName, phone: existing.phone, jobTitle },
  });
  await prisma.joinRequest.update({
    where: { id: input.requestId },
    data: { status: 'APPROVED', reviewedById: input.reviewedById, reviewedAt: new Date(), createdUserId: created.id },
  });
  await writeAuditLog(prisma, {
    locationId: existing.locationId,
    actorId: input.reviewedById,
    action: 'JOIN_APPROVED',
    entityType: 'JoinRequest',
    entityId: input.requestId,
    note: `Approved join request for ${existing.fullName} — created User ${created.id}`,
  });
  return { result: 'ok', status: 'APPROVED', userId: created.id };
}
