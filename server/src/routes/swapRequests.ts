import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { isRequestLocked, nextRequestWindowClose } from '../lib/swapRequestPolicy.js';

export const swapRequestsRouter = Router();

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
    shift: { userId: string | null };
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
      include: {
        requestedBy: { select: { fullName: true } },
        targetUser: { select: { fullName: true } },
        shift: { select: { userId: true } },
      },
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
      include: {
        requestedBy: { select: { fullName: true } },
        targetUser: { select: { fullName: true } },
        shift: { select: { userId: true } },
      },
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

    const [updated] = await prisma.$transaction([
      prisma.shiftSwapRequest.update({
        where: { id },
        data: { status, reviewedById, reviewedAt: new Date(), managerNote },
        include: {
          requestedBy: { select: { fullName: true } },
          targetUser: { select: { fullName: true } },
          shift: { select: { userId: true } },
        },
      }),
      ...(decision === 'approved' && existing.targetUserId
        ? [prisma.shift.update({ where: { id: existing.shiftId }, data: { userId: existing.targetUserId } })]
        : []),
      prisma.auditLog.create({
        data: {
          locationId: existing.shift.locationId,
          actorId: reviewedById,
          shiftId: existing.shiftId,
          action: decision === 'approved' ? 'SWAP_APPROVED' : 'SWAP_DECLINED',
          entityType: 'ShiftSwapRequest',
          entityId: id,
          note: managerNote,
        },
      }),
    ]);

    return res.status(200).json({ request: toDto(updated) });
  } catch (err) {
    console.error('[swapRequests.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the swap request.' });
  }
});
