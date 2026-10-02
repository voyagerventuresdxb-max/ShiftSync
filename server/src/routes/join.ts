import { Router, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requestOtpCode, OtpRateLimitError, verifyOtpCode, issueSession } from '../lib/identity.js';
import { toE164, INVALID_PHONE_ERROR } from '../lib/phone.js';
import { findUserByPhone } from './identity.js';
import { otpRequestIpLimiter, sendOtpRateLimited, invitePeekLimiter } from '../middleware/rateLimit.js';
import {
  INVITE_REJECTION_MESSAGES,
  INVITE_TOKEN_SHAPE,
  consumeInviteUse,
  currentInviteRejection,
  inviteLinkRejection,
  isLegacyJoinLinkAccepted,
  type InviteRejection,
} from '../lib/inviteLinks.js';
import {
  decideJoinRequest,
  fileJoinRequest,
  joinAttemptsExhaustedMessage,
  joinDeclinedMessage,
  JOIN_PHONE_TAKEN_ERROR,
} from '../lib/actions/joinActions.js';
import { requireSession, requireManager, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { requireOtpEnabled } from '../middleware/requireOtpEnabled.js';
import { notifyUser } from '../lib/push.js';
import { getManagerIdsForLocation, getApproverNameForLocation } from '../lib/managers.js';
import { devOtpEchoFor, logDevOtpEcho } from '../lib/devOtpEcho.js';

export const joinRouter = Router();

function sendInviteRejected(res: Response, reason: InviteRejection) {
  return res.status(410).json({ reason, error: INVITE_REJECTION_MESSAGES[reason] });
}

/** GET /api/join/invite/:token — public peek: 200 { venueName, expiresAt } or 410 { reason, error }. */
joinRouter.get('/invite/:token', invitePeekLimiter, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { token } = req.params;
    const link = INVITE_TOKEN_SHAPE.test(token)
      ? await prisma.inviteLink.findUnique({ where: { token }, include: { location: { select: { name: true } } } })
      : null;
    const rejection = inviteLinkRejection(link);
    if (rejection || !link) return sendInviteRejected(res, rejection ?? 'not_found');
    return res.status(200).json({ venueName: link.location.name, expiresAt: link.expiresAt.toISOString() });
  } catch (err) {
    console.error('[join.invitePeek] failed', err);
    return res.status(500).json({ error: 'Unexpected error while checking the invite link.' });
  }
});

/** POST /api/join/request-otp — body: { phone } — join path, no existing-match requirement. */
joinRouter.post('/request-otp', requireOtpEnabled, otpRequestIpLimiter, async (req, res) => {
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
 * POST /api/join/verify-otp — body: { inviteToken | locationId, phone, code, fullName? }
 *
 * `inviteToken` is the venue's invite link (lib/inviteLinks.ts); a bare
 * `locationId` is an old `/join?location=` link, honoured only until the
 * venue's `legacyJoinLinksUntil`. An unusable link is a 410 after the code
 * check, before anything is filed.
 *
 * On success: if `phone` matches an existing active User (by digits), issues
 * a real session immediately — this IS the auto-match the directive
 * describes. Otherwise creates a real PENDING JoinRequest (fullName
 * required in this branch) and returns `pending: true` with no session —
 * the "fallback to manual entry landing in Pending Approvals" path. A
 * request already PENDING here is returned as-is (200). A declined applicant
 * may apply again, up to `MAX_JOIN_ATTEMPTS` requests per phone per venue;
 * past that it's a 403. Only a new request or a session counts as a use of
 * the invite link.
 */
joinRouter.post('/verify-otp', requireOtpEnabled, async (req, res) => {
  try {
    const inviteToken = String(req.body?.inviteToken ?? '').trim();
    const legacyLocationId = inviteToken ? '' : String(req.body?.locationId ?? '').trim();
    const rawPhone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    const fullName = req.body?.fullName ? String(req.body.fullName).trim() : null;
    if (!inviteToken && !legacyLocationId) return res.status(400).json({ error: 'inviteToken is required.' });
    if (!rawPhone || !code) return res.status(400).json({ error: 'phone and code are required.' });
    const phone = toE164(rawPhone);
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_ERROR });

    const link =
      inviteToken && INVITE_TOKEN_SHAPE.test(inviteToken)
        ? await prisma.inviteLink.findUnique({ where: { token: inviteToken }, include: { location: true } })
        : null;
    const location = inviteToken ? (link?.location ?? null) : await prisma.location.findUnique({ where: { id: legacyLocationId } });
    if (!inviteToken && !location) return res.status(404).json({ error: `Location "${legacyLocationId}" not found.` });

    const result = await verifyOtpCode(phone, 'JOIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    const rejection = inviteToken ? inviteLinkRejection(link) : location && !isLegacyJoinLinkAccepted(location) ? 'legacy_expired' : null;
    if (rejection || !location) return sendInviteRejected(res, rejection ?? 'not_found');
    const locationId = location.id;

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
      if (link && !(await consumeInviteUse(prisma, link.id))) return sendInviteRejected(res, await currentInviteRejection(link.id));
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

    // A returning applicant gets their current status back, never a duplicate request or a second manager ping.
    const filing = await fileJoinRequest({ locationId, phone, fullName, inviteLinkId: link?.id ?? null });
    if (filing.kind === 'link_unusable') return sendInviteRejected(res, await currentInviteRejection(link!.id));
    if (filing.kind === 'exhausted') {
      return res.status(403).json({ status: 'attempts_exhausted', venueName: location.name, error: joinAttemptsExhaustedMessage(location.name) });
    }
    if (filing.kind === 'needs_name') {
      return res.status(400).json(
        filing.declined
          ? { status: 'declined', venueName: location.name, error: joinDeclinedMessage(location.name, true) }
          : { error: 'No existing match — fullName is required to submit a join request for manual review.' },
      );
    }

    if (filing.kind === 'created') {
      // Real delivery on top of the write above (never blocking the response
      // — a push failure must not stop the applicant's request from going
      // through). The applicant has no User to notify until approval, where
      // `decideJoinRequest` leaves them an in-app notice for their first sign-in.
      const managerIds = await getManagerIdsForLocation(locationId);
      for (const managerId of managerIds) {
        void notifyUser(managerId, {
          title: 'New join request',
          body: `${filing.fullName} wants to join — review their request.`,
          url: '/people',
        });
      }
    }

    return res.status(filing.kind === 'created' ? 201 : 200).json({
      pending: true,
      joinRequestId: filing.requestId,
      venueName: location.name,
      managerName: await getApproverNameForLocation(locationId),
    });
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
    // This venue's declines only: another venue's history isn't this manager's to see.
    const declines = requests.length
      ? await prisma.joinRequest.groupBy({
          by: ['phone'],
          where: { locationId, status: 'DECLINED', phone: { in: requests.map((r) => r.phone) } },
          _count: { _all: true },
          _max: { reviewedAt: true, createdAt: true },
        })
      : [];
    const declinesByPhone = new Map(declines.map((d) => [d.phone, d]));
    return res.status(200).json({
      requests: requests.map((r) => {
        const d = declinesByPhone.get(r.phone);
        return {
          id: r.id,
          phone: r.phone,
          fullName: r.fullName,
          createdAt: r.createdAt.toISOString(),
          previousDeclines: d?._count._all ?? 0,
          lastDeclinedAt: (d?._max.reviewedAt ?? d?._max.createdAt)?.toISOString() ?? null,
        };
      }),
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
    if (outcome.result === 'phone_taken') return res.status(409).json({ error: JOIN_PHONE_TAKEN_ERROR });

    return res.status(200).json({ status: outcome.status, userId: outcome.userId });
  } catch (err) {
    console.error('[join.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the join request.' });
  }
});
