import { Router } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { prisma } from '../lib/prisma.js';
import { isRequestLocked } from '../lib/swapRequestPolicy.js';
import { requireSession, requireManager } from '../middleware/requireSession.js';
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
swapRequestsRouter.get('/:locationId', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (locationId !== req.user!.locationId) {
      return res.status(403).json({ error: 'You do not have access to this location.' });
    }
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

/**
 * POST /api/swap-requests — body: { shiftId, targetUserId, reason?, requestedById? }
 *
 * `requestedById` is only ever honored for a MANAGER/OWNER session — a STAFF
 * caller's body is never read for it; the requester is always their own
 * session id. This mirrors voice.ts's REQUEST_SWAP handling exactly (same
 * shift-ownership check, same 404 wording, same location-scoped target
 * lookup) — see that file's `/execute` handler for the canonical version.
 */
swapRequestsRouter.post('/', requireSession, async (req, res) => {
  try {
    const shiftId = String(req.body?.shiftId ?? '').trim();
    const targetUserId = String(req.body?.targetUserId ?? '').trim();
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;

    if (!shiftId) return res.status(400).json({ error: 'shiftId is required.' });
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required.' });

    const locationId = req.user!.locationId;

    // A manager/owner may file a swap request on behalf of whichever employee
    // is selected in SchedulingRoute's "Viewing" dropdown — an existing,
    // intentional capability, not a bug — via `requestedById` in the body,
    // falling back to their own id when omitted. A STAFF session can only
    // ever file for themselves: `requestedById` is never read in that case.
    const effectiveRequesterId =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.requestedById ? String(req.body.requestedById).trim() : '') || req.user!.id;

    const shift = await prisma.shift.findUnique({
      where: { id: shiftId },
      select: { id: true, userId: true, locationId: true },
    });
    if (!shift || shift.userId !== effectiveRequesterId || shift.locationId !== locationId) {
      return res.status(404).json({ error: 'That shift could not be found among your own upcoming shifts.' });
    }

    // The proposed cover must be a real, active staff member at the SAME
    // location — mirrors voice.ts's REQUEST_SWAP validation exactly.
    const target = await prisma.user.findFirst({
      where: { id: targetUserId, locationId, isActive: true },
      select: { id: true },
    });
    if (!target) return res.status(404).json({ error: 'That staff member could not be found at your location.' });

    const created = await createSwapRequest({ shiftId, requestedById: effectiveRequesterId, targetUserId, reason });

    // actorId is always the real caller — who clicked the button — even when
    // requestedById names someone else. Never the effective requester.
    let onBehalfNote: string | undefined;
    if (effectiveRequesterId !== req.user!.id) {
      const requester = await prisma.user.findUnique({
        where: { id: effectiveRequesterId },
        select: { fullName: true },
      });
      onBehalfNote = `Requested on behalf of ${requester?.fullName ?? effectiveRequesterId}`;
    }
    await prisma.auditLog.create({
      data: {
        locationId,
        actorId: req.user!.id,
        shiftId,
        action: 'SWAP_REQUESTED',
        entityType: 'ShiftSwapRequest',
        entityId: created.id,
        note: onBehalfNote,
      },
    });

    return res.status(201).json({ request: toDto(created) });
  } catch (err) {
    console.error('[swapRequests.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while creating the swap request.' });
  }
});

/**
 * PATCH /api/swap-requests/:id — body: { decision: 'approved' | 'denied' }
 *
 * Manager/owner-only (mirrors voice.ts: APPROVE_SWAP/DECLINE_SWAP are in
 * MANAGER_INTENTS, not STAFF_INTENTS). `reviewedById` in the body is never
 * read — the reviewer is always the caller's own session id, no on-behalf-of
 * case here. Location-scoped before `decideSwapRequest` runs at all, since
 * that function does not location-check itself.
 */
swapRequestsRouter.patch('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const decision = req.body?.decision;
    if (decision !== 'approved' && decision !== 'denied') {
      return res.status(400).json({ error: 'decision must be "approved" or "denied".' });
    }

    const sr = await prisma.shiftSwapRequest.findUnique({
      where: { id },
      include: { shift: { select: { locationId: true } } },
    });
    if (!sr || sr.shift.locationId !== req.user!.locationId) {
      return res.status(404).json({ error: 'That swap request could not be found.' });
    }

    const outcome = await decideSwapRequest({
      id,
      decision: decision === 'approved' ? 'approved' : 'declined',
      reviewedById: req.user!.id,
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
