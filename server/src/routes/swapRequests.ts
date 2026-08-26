import { Router } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { prisma } from '../lib/prisma.js';
import { isRequestLocked, nextRequestWindowClose } from '../lib/swapRequestPolicy.js';

dayjs.extend(utc);

export const swapRequestsRouter = Router();

/**
 * The Prisma `include` every swap-request read uses. Kept in one place so the
 * list/create/decide paths can never drift apart on which relation fields
 * `toDto` is allowed to read.
 */
const SWAP_REQUEST_INCLUDE = {
  requestedBy: { select: { fullName: true } },
  targetUser: { select: { fullName: true } },
  shift: { select: { userId: true, date: true, startTime: true, endTime: true } },
} as const;

/**
 * Human-readable shift label, e.g. "Mon 25 Aug · 09:00–17:00".
 *
 * Built server-side so the Approvals panel does not depend on an in-memory
 * roster that is empty on a fresh page load. Formatted in UTC (same rationale
 * as `parsing/normalize.ts`): the stored wall-clock date/time is what matters,
 * not how the server's local timezone happens to render it.
 */
function shiftLabelOf(shift: { date: Date; startTime: Date; endTime: Date }): string {
  const day = dayjs.utc(shift.date).format('ddd D MMM');
  const start = dayjs.utc(shift.startTime).format('HH:mm');
  const end = dayjs.utc(shift.endTime).format('HH:mm');
  return `${day} · ${start}–${end}`;
}

/**
 * Thrown inside the decide transaction when the atomic `shift.updateMany`
 * guard finds the shift's owner no longer matches `requestedById` — i.e. a
 * different request already reassigned this shift between our initial read
 * and this write. Thrown (rather than just returning a flag) so the
 * transaction rolls back the status/audit writes too, instead of leaving a
 * false "approved" record with no matching reassignment.
 */
class ShiftAlreadyReassignedError extends Error {}

function toDto(
  r: {
    id: string;
    shiftId: string;
    requestedById: string;
    targetUserId: string | null;
    status: string;
    expiresAt: Date;
    managerNote: string | null;
    createdAt: Date;
    reviewedAt: Date | null;
    requestedBy: { fullName: string };
    targetUser: { fullName: string } | null;
    shift: { userId: string | null; date: Date; startTime: Date; endTime: Date };
  },
) {
  const statusMap: Record<string, 'pending' | 'approved' | 'denied'> = {
    PENDING: 'pending',
    APPROVED: 'approved',
    DECLINED: 'denied',
  };
  return {
    id: r.id,
    shiftId: r.shiftId,
    requestedBy: r.requestedById,
    coveringEmployeeId: r.targetUserId,
    // Names and label are resolved server-side from the included relations so
    // the client never has to look them up in a roster it may not have loaded.
    requesterName: r.requestedBy.fullName,
    coveringName: r.targetUser?.fullName ?? null,
    shiftLabel: shiftLabelOf(r.shift),
    status: statusMap[r.status] ?? 'pending',
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.reviewedAt?.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    locked: isRequestLocked({ status: r.status }, { userId: r.shift.userId }, r.requestedById),
    auditNote: r.managerNote ?? undefined,
  };
}

/** GET /api/swap-requests/:locationId — every request for a shift in this location. */
swapRequestsRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const rows = await prisma.shiftSwapRequest.findMany({
      where: { shift: { locationId } },
      orderBy: { createdAt: 'desc' },
      include: SWAP_REQUEST_INCLUDE,
    });
    return res.status(200).json({ requests: rows.map(toDto) });
  } catch (err) {
    console.error('[swapRequests.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading swap requests.' });
  }
});

/** POST /api/swap-requests — body: { shiftId, requestedById, targetUserId, reason? } */
swapRequestsRouter.post('/', async (req, res) => {
  try {
    const shiftId = String(req.body?.shiftId ?? '').trim();
    const requestedById = String(req.body?.requestedById ?? '').trim();
    const targetUserId = String(req.body?.targetUserId ?? '').trim();
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;

    if (!shiftId) return res.status(400).json({ error: 'shiftId is required.' });
    if (!requestedById) return res.status(400).json({ error: 'requestedById is required.' });
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required.' });

    const shift = await prisma.shift.findUnique({ where: { id: shiftId }, select: { id: true, userId: true } });
    if (!shift) return res.status(404).json({ error: `Shift "${shiftId}" not found.` });

    // Validate both user ids before writing. Without this, an id that is not a
    // real User (e.g. the client's synthetic `upload-emp-<name>` fallback for an
    // unresolved roster row) reaches the FK constraint and surfaces as an opaque
    // 500 instead of telling the caller which id was wrong.
    const requester = await prisma.user.findUnique({ where: { id: requestedById }, select: { id: true } });
    if (!requester) return res.status(404).json({ error: `Requesting user "${requestedById}" not found.` });

    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) return res.status(404).json({ error: `Target user "${targetUserId}" not found.` });

    const created = await prisma.shiftSwapRequest.create({
      data: {
        shiftId,
        requestedById,
        targetUserId,
        type: 'COVER',
        status: 'PENDING',
        reason,
        expiresAt: nextRequestWindowClose(),
      },
      include: SWAP_REQUEST_INCLUDE,
    });
    return res.status(201).json({ request: toDto(created) });
  } catch (err) {
    console.error('[swapRequests.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while creating the swap request.' });
  }
});

/** PATCH /api/swap-requests/:id — body: { decision: 'approved' | 'denied', reviewedById? } */
swapRequestsRouter.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const decision = req.body?.decision;
    if (decision !== 'approved' && decision !== 'denied') {
      return res.status(400).json({ error: 'decision must be "approved" or "denied".' });
    }
    const reviewedById = req.body?.reviewedById ? String(req.body.reviewedById).trim() : null;

    const existing = await prisma.shiftSwapRequest.findUnique({
      where: { id },
      include: { requestedBy: { select: { fullName: true } }, targetUser: { select: { fullName: true } }, shift: true },
    });
    if (!existing) return res.status(404).json({ error: `Swap request "${id}" not found.` });

    if (isRequestLocked({ status: existing.status }, { userId: existing.shift.userId }, existing.requestedById)) {
      return res.status(409).json({
        error: 'This shift was already reassigned by another approved request — this one can no longer be approved.',
      });
    }

    const status = decision === 'approved' ? 'APPROVED' : 'DECLINED';
    const managerNote =
      decision === 'approved'
        ? `Approved · shift reassigned to ${existing.targetUser?.fullName ?? 'the proposed cover'}`
        : 'Declined';

    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Atomic guard: only reassign the shift if it is still owned by the
        // same user who requested the swap. This is the real source of
        // truth against the TOCTOU race — two managers approving two
        // different pending requests for the same shift can both pass the
        // earlier informational `isRequestLocked` check (which only reflects
        // what was true at read time), but only one `updateMany` here can
        // ever match and actually flip `userId`.
        if (decision === 'approved' && existing.targetUserId) {
          const reassigned = await tx.shift.updateMany({
            where: { id: existing.shiftId, userId: existing.requestedById },
            data: { userId: existing.targetUserId },
          });
          if (reassigned.count === 0) {
            // Someone else's approval already moved this shift out from
            // under the original requester. Throwing here rolls back the
            // whole transaction, so we do NOT let the status/audit writes
            // below stand as if this approval had actually happened.
            throw new ShiftAlreadyReassignedError();
          }
        }

        const updatedRequest = await tx.shiftSwapRequest.update({
          where: { id },
          data: { status, reviewedById, reviewedAt: new Date(), managerNote },
          include: SWAP_REQUEST_INCLUDE,
        });

        await tx.auditLog.create({
          data: {
            locationId: existing.shift.locationId,
            actorId: reviewedById,
            shiftId: existing.shiftId,
            action: decision === 'approved' ? 'SWAP_APPROVED' : 'SWAP_DECLINED',
            entityType: 'ShiftSwapRequest',
            entityId: id,
            note: managerNote,
          },
        });

        return updatedRequest;
      });

      return res.status(200).json({ request: toDto(updated) });
    } catch (err) {
      if (err instanceof ShiftAlreadyReassignedError) {
        return res.status(409).json({
          error: 'This shift was already reassigned by another approved request — this one can no longer be approved.',
        });
      }
      throw err;
    }
  } catch (err) {
    console.error('[swapRequests.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the swap request.' });
  }
});
