import { Router } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { prisma } from '../lib/prisma.js';
import { isRequestLocked } from '../lib/swapRequestPolicy.js';
import {
  SWAP_REQUEST_INCLUDE,
  createSwapRequest,
  decideSwapRequest,
} from '../lib/actions/swapActions.js';

dayjs.extend(utc);

export const swapRequestsRouter = Router();

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

    const created = await createSwapRequest({ shiftId, requestedById, targetUserId, reason });
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

    const outcome = await decideSwapRequest({
      id,
      decision: decision === 'approved' ? 'approved' : 'declined',
      reviewedById,
    });

    if (outcome.result === 'not_found') return res.status(404).json({ error: `Swap request "${id}" not found.` });
    if (outcome.result === 'conflict') {
      return res.status(409).json({
        error: 'This shift was already reassigned by another approved request — this one can no longer be approved.',
      });
    }

    return res.status(200).json({ request: toDto(outcome.request) });
  } catch (err) {
    console.error('[swapRequests.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the swap request.' });
  }
});
