import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requestOtpCode, OtpRateLimitError, verifyOtpCode, issueSession } from '../lib/identity.js';
import { toE164, INVALID_PHONE_ERROR } from '../lib/phone.js';
import { findUserByPhone } from './identity.js';
import { otpRequestIpLimiter, sendOtpRateLimited } from '../middleware/rateLimit.js';
import { decideJoinRequest } from '../lib/actions/joinActions.js';
import { requireSession, requireManager, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { notifyUser } from '../lib/push.js';
import { getManagerIdsForLocation } from '../lib/managers.js';
import { devOtpEchoFor, logDevOtpEcho } from '../lib/devOtpEcho.js';

export const joinRouter = Router();

/** POST /api/join/request-otp — body: { phone } — join path, no existing-match requirement. */
joinRouter.post('/request-otp', otpRequestIpLimiter, async (req, res) => {
  try {
    const rawPhone = String(req.body?.phone ?? '').trim();
    if (!rawPhone) return res.status(400).json({ error: 'phone is required.' });
    const phone = toE164(rawPhone);
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_ERROR });

    const { plainCode, expiresAt } = await requestOtpCode(phone, 'JOIN');
    // No SMS integration exists; this is a stand-in until one is added.
    const echo = devOtpEchoFor(phone);
    if (echo) logDevOtpEcho('join', phone, 'JOIN', plainCode);

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: echo ? plainCode : undefined,
    });
  } catch (err) {
    if (err instanceof OtpRateLimitError) return sendOtpRateLimited(res, err.scope, err.retryAfterSeconds);
    console.error('[join.requestOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while requesting a code.' });
  }
});

/**
 * POST /api/join/verify-otp — body: { locationId, phone, code, fullName? }
 *
 * On success: if `phone` matches an existing active User (by digits), issues
 * a real session immediately — this IS the auto-match the directive
 * describes. Otherwise creates a real PENDING JoinRequest (fullName
 * required in this branch) and returns `pending: true` with no session —
 * the "fallback to manual entry landing in Pending Approvals" path.
 */
joinRouter.post('/verify-otp', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const rawPhone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    const fullName = req.body?.fullName ? String(req.body.fullName).trim() : null;
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!rawPhone || !code) return res.status(400).json({ error: 'phone and code are required.' });
    const phone = toE164(rawPhone);
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_ERROR });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const result = await verifyOtpCode(phone, 'JOIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    // `User.phone` is E.164 and globally unique (deactivated users included),
    // so this is the one possible match. A number held at ANOTHER venue, or by
    // a deactivated record here, can't join: approving the request would
    // collide on that unique phone. Say so now instead of filing a request
    // that can never be approved.
    const existing = await findUserByPhone(phone);
    if (existing && existing.locationId !== locationId) {
      return res.status(409).json({ error: 'This phone number is already registered at another venue.' });
    }
    if (existing && !existing.isActive) {
      return res.status(409).json({ error: 'This phone number belongs to a deactivated staff record — ask a manager to reactivate it.' });
    }
    const match = existing;

    if (match) {
      const { plainToken, expiresAt } = await issueSession(match.id);
      return res.status(200).json({
        pending: false,
        token: plainToken,
        expiresAt: expiresAt.toISOString(),
        user: {
          id: match.id,
          fullName: match.fullName,
          jobTitle: match.jobTitle,
          locationId: match.locationId,
          systemRole: match.systemRole,
        },
      });
    }

    if (!fullName) {
      return res.status(400).json({ error: 'No existing match — fullName is required to submit a join request for manual review.' });
    }
    const joinRequest = await prisma.joinRequest.create({
      data: { locationId, phone, fullName, status: 'PENDING' },
    });

    // Real delivery on top of the write above (never blocking the response
    // — a push failure must not stop the applicant's request from going
    // through). The applicant themselves cannot be notified here or on
    // decision — they have no User/session/push subscription until a
    // manager approves them, a separate deferred infra gap.
    const managerIds = await getManagerIdsForLocation(locationId);
    for (const managerId of managerIds) {
      void notifyUser(managerId, {
        title: 'New join request',
        body: `${fullName} wants to join — review their request.`,
        url: '/people',
      });
    }

    return res.status(201).json({ pending: true, joinRequestId: joinRequest.id });
  } catch (err) {
    console.error('[join.verifyOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while verifying the code.' });
  }
});

/** GET /api/join/:locationId/pending — list PENDING join requests for Pending Approvals. Manager-only, own location. */
joinRouter.get('/:locationId/pending', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const requests = await prisma.joinRequest.findMany({
      where: { locationId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    return res.status(200).json({
      requests: requests.map((r) => ({
        id: r.id,
        phone: r.phone,
        fullName: r.fullName,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[join.pending.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading pending join requests.' });
  }
});

/**
 * PATCH /api/join/:requestId — body: { decision: 'approve'|'decline', jobTitle? }
 * Approving creates a real, active User from the request's phone/fullName
 * and links it back onto the request — this is the one place a JoinRequest
 * ever produces a real staff member. Manager-only, scoped to the caller's
 * own location; the reviewer is always the authenticated caller — there is
 * no legitimate on-behalf-of case for reviewing someone else's join request.
 */
joinRouter.patch('/:requestId', requireSession, requireManager, async (req, res) => {
  try {
    const { requestId } = req.params;
    const decision = String(req.body?.decision ?? '');
    if (decision !== 'approve' && decision !== 'decline') {
      return res.status(400).json({ error: 'decision must be "approve" or "decline".' });
    }

    const jr = await prisma.joinRequest.findUnique({ where: { id: requestId } });
    if (!ownedOrNotFound(req, res, jr, 'That join request could not be found.')) return;

    const jobTitle = req.body?.jobTitle ? String(req.body.jobTitle).trim() : null;

    const outcome = await decideJoinRequest({ requestId, decision, reviewedById: req.user!.id, jobTitle });

    if (outcome.result === 'not_found') return res.status(404).json({ error: `Join request "${requestId}" not found.` });
    if (outcome.result === 'already_reviewed') {
      return res.status(409).json({ error: 'This request has already been reviewed.' });
    }

    return res.status(200).json({ status: outcome.status, userId: outcome.userId });
  } catch (err) {
    console.error('[join.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the join request.' });
  }
});
