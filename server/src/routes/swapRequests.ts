import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { isRequestLocked } from '../lib/swapRequestPolicy.js';
import { requireSession, requireManager, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { canSeeDraftShifts } from '../lib/shiftVisibility.js';
import {
  SWAP_REQUEST_INCLUDE,
  createSwapRequest,
  decideSwapRequest,
  notifySwapRequested,
  notifySwapDecided,
  shiftLabelOf,
} from '../lib/actions/swapActions.js';

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
    if (!assertOwnsLocation(req, res, locationId)) return;
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

    // Neither lookup depends on the other's result (the target check doesn't
    // need anything from the shift row) — run them concurrently rather than
    // paying two sequential round-trips.
    const [shift, target] = await Promise.all([
      prisma.shift.findUnique({
        where: { id: shiftId },
        select: { id: true, userId: true, locationId: true, status: true },
      }),
      // The proposed cover must be a real, active staff member at the SAME
      // location — mirrors voice.ts's REQUEST_SWAP validation exactly.
      prisma.user.findFirst({
        where: { id: targetUserId, locationId, isActive: true },
        select: { id: true },
      }),
    ]);
    // A draft is invisible to staff (lib/shiftVisibility.ts), so it can't be
    // swapped by them either — same 404 as "not yours", nothing leaked.
    const hiddenDraft = shift?.status !== 'PUBLISHED' && !canSeeDraftShifts(req.user, locationId);
    if (!shift || hiddenDraft || shift.userId !== effectiveRequesterId || shift.locationId !== locationId) {
      return res.status(404).json({ error: 'That shift could not be found among your own upcoming shifts.' });
    }
    if (!target) return res.status(404).json({ error: 'That staff member could not be found at your location.' });

    // actorId is always the real caller — who clicked the button — even when
    // requestedById names someone else. Never the effective requester. This
    // read doesn't depend on the swap creation below, so it runs ahead of
    // the transaction rather than inside it.
    let onBehalfNote: string | undefined;
    if (effectiveRequesterId !== req.user!.id) {
      const requester = await prisma.user.findUnique({
        where: { id: effectiveRequesterId },
        select: { fullName: true },
      });
      onBehalfNote = `Requested on behalf of ${requester?.fullName ?? effectiveRequesterId}`;
    }

    const created = await withAuditedTransaction(
      prisma,
      (tx) => createSwapRequest({ shiftId, requestedById: effectiveRequesterId, targetUserId, reason }, tx),
      (request) => ({
        locationId,
        actorId: req.user!.id,
        shiftId,
        action: 'SWAP_REQUESTED',
        entityType: 'ShiftSwapRequest',
        entityId: request.id,
        note: onBehalfNote,
      }),
    );

    // Real delivery on top of the write above (never inside the transaction
    // — a push failure must not roll back the request). Shared with
    // routes/voice.ts's REQUEST_SWAP, which creates requests the same way
    // via createSwapRequest — one notification path for both entry points.
    void notifySwapRequested(created, locationId);

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
    if (!ownedOrNotFound(req, res, sr?.shift ?? null, 'That swap request could not be found.')) return;

    const outcome = await decideSwapRequest({
      id,
      decision: decision === 'approved' ? 'approved' : 'declined',
      reviewedById: req.user!.id,
    });

    if (outcome.result === 'not_found') return res.status(404).json({ error: `Swap request "${id}" not found.` });
    if (outcome.result === 'target_on_leave') return res.status(409).json({ error: outcome.message });
    if (outcome.result === 'conflict') {
      return res.status(409).json({
        error: 'This shift was already reassigned by another approved request — this one can no longer be approved.',
      });
    }

    // Real delivery on top of the write above (never inside the transaction
    // — a push failure must not roll back the decision). Shared with
    // routes/voice.ts's APPROVE_SWAP/DECLINE_SWAP, which decides requests
    // the same way via decideSwapRequest — one notification path for both
    // entry points.
    void notifySwapDecided(outcome.request, decision === 'approved' ? 'approved' : 'declined');

    return res.status(200).json({ request: toDto(outcome.request) });
  } catch (err) {
    console.error('[swapRequests.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the swap request.' });
  }
});
