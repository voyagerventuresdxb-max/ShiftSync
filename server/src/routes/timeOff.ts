import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { findVenueUser } from '../lib/shiftRules.js';
import { venueTimezoneFor, venueToday } from '../lib/venueTime.js';
import { notifyUser } from '../lib/push.js';
import { getManagerIdsForLocation } from '../lib/managers.js';
import { dayRangeLabel } from '../lib/actions/weekActions.js';
import { createTimeOffRequest, decideTimeOffRequest, TIME_OFF_INCLUDE, timeOffToDto } from '../lib/actions/timeOffActions.js';
import { LEAVE_LABELS, type LeaveTypeCode } from '../../../shared/rotaWeek.js';

/**
 * Rota builder v2 — time-off requests (shared/rotaWeek.ts: TimeOffRequestDto,
 * TimeOffDecisionInput). Staff file for themselves; a manager may file for
 * someone of their venue; only a manager decides. Approving goes through the
 * week patch (lib/actions/timeOffActions.ts), so the grid's version bumps and
 * the days lock in the same transaction as the decision.
 */
export const timeOffRouter = Router();

/**
 * POST /api/time-off — body: { userId?, startDate, endDate, reason? } → 201 { request }.
 * A STAFF session files for itself only (another `userId` is a 403); a manager
 * may name an active person of their own venue (anyone else is a 404). 400 for
 * bad or past dates, 409 when a pending request already covers some of the days.
 * The venue's managers are told a request is waiting.
 */
timeOffRouter.post('/', requireSession, async (req, res) => {
  try {
    const caller = req.user!;
    const named = req.body?.userId ? String(req.body.userId).trim() : '';
    let userId = caller.id;
    if (named && named !== caller.id) {
      if (caller.systemRole === 'STAFF') return res.status(403).json({ error: 'You can only request time off for yourself.' });
      const person = await findVenueUser(named, caller.locationId, { activeOnly: true });
      if (!person || person.deletedAt) return res.status(404).json({ error: `Staff member "${named}" not found.` });
      userId = person.id;
    }
    const startDate = String(req.body?.startDate ?? '').trim();
    const endDate = String(req.body?.endDate ?? '').trim();
    const reason = req.body?.reason ? String(req.body.reason) : null;
    const timezone = await venueTimezoneFor(caller.locationId);
    if (/^\d{4}-\d{2}-\d{2}$/.test(startDate) && startDate < venueToday(timezone)) {
      return res.status(400).json({ error: 'The first day has already passed.' });
    }

    const created = await withAuditedTransaction(
      prisma,
      (tx) => createTimeOffRequest({ userId, startDate, endDate, reason }, tx),
      (r) =>
        r.result === 'ok'
          ? {
              locationId: caller.locationId,
              actorId: caller.id,
              action: 'TIME_OFF_REQUESTED',
              entityType: 'TimeOffRequest',
              entityId: r.id,
              note: `Time off ${r.startDate}${r.endDate !== r.startDate ? ` to ${r.endDate}` : ''}${userId !== caller.id ? ' (filed by a manager)' : ''}`,
            }
          : null,
    );
    if (created.result === 'invalid') return res.status(400).json({ error: created.message });
    if (created.result === 'duplicate') return res.status(409).json({ error: created.message, errorCode: 'time_off_duplicate', requestId: created.id });

    const request = await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: created.id }, include: TIME_OFF_INCLUDE });
    // After commit, never inside it: the managers' notice is an enhancement, the request stands without it.
    if (caller.systemRole === 'STAFF') {
      const label = dayRangeLabel(created.startDate, created.endDate);
      for (const managerId of await getManagerIdsForLocation(caller.locationId)) {
        await notifyUser(managerId, { title: 'Time-off request', body: `${request.user.fullName} asked for time off: ${label}`, url: '/scheduling' });
      }
    }
    return res.status(201).json({ request: timeOffToDto(request) });
  } catch (err) {
    console.error('[timeOff.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while filing the request.' });
  }
});

/**
 * GET /api/time-off/:locationId?status=pending|all → { requests }.
 * Any session of the venue; STAFF see only their own. `pending` (the default)
 * lists open requests oldest first; `all` the latest 200 pending, approved and
 * declined requests, newest first.
 */
timeOffRouter.get('/:locationId', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const status = String(req.query.status ?? 'pending');
    if (status !== 'pending' && status !== 'all') return res.status(400).json({ error: 'status must be "pending" or "all".' });
    const own = req.user!.systemRole === 'STAFF';
    const rows = await prisma.timeOffRequest.findMany({
      where: {
        user: { locationId },
        ...(own ? { userId: req.user!.id } : {}),
        status: status === 'pending' ? 'PENDING' : { in: ['PENDING', 'APPROVED', 'DECLINED'] },
      },
      include: TIME_OFF_INCLUDE,
      orderBy: { createdAt: status === 'pending' ? 'asc' : 'desc' },
      take: 200,
    });
    return res.status(200).json({ requests: rows.map(timeOffToDto) });
  } catch (err) {
    console.error('[timeOff.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading time-off requests.' });
  }
});

/**
 * PATCH /api/time-off/:id — body: TimeOffDecisionInput { decision: 'approve' | 'decline', leaveType?, note? } (manager).
 * 200 { result: 'ok', request, versions } | 404 (missing, or another venue's) | 409 { result: 'not_pending' } |
 * 422 { result: 'refused', refusal, message } when the week patch refuses (e.g. the person was deactivated).
 */
timeOffRouter.patch('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'decline') return res.status(400).json({ error: 'decision must be "approve" or "decline".' });
    const leaveType = req.body?.leaveType as unknown;
    if (leaveType !== undefined && leaveType !== null && (typeof leaveType !== 'string' || !Object.hasOwn(LEAVE_LABELS, leaveType))) {
      return res.status(400).json({ error: `leaveType must be one of ${Object.keys(LEAVE_LABELS).join(', ')}.` });
    }
    const note = req.body?.note ? String(req.body.note) : null;
    const outcome = await decideTimeOffRequest({
      id: req.params.id,
      locationId: req.user!.locationId,
      reviewerId: req.user!.id,
      decision,
      ...(typeof leaveType === 'string' ? { leaveType: leaveType as LeaveTypeCode } : {}),
      note,
    });
    if (outcome.result === 'not_found') return res.status(404).json({ error: 'That time-off request could not be found.' });
    if (outcome.result === 'not_pending') return res.status(409).json({ result: 'not_pending', error: 'This request was already decided.' });
    if (outcome.result === 'refused') return res.status(422).json({ result: 'refused', refusal: outcome.refusal, message: outcome.message, error: outcome.message });
    return res.status(200).json(outcome);
  } catch (err) {
    console.error('[timeOff.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the request.' });
  }
});
