import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { createOtpCode, verifyOtpCode, issueSession, phoneDigits } from '../lib/identity.js';

export const joinRouter = Router();

/**
 * Fail-closed, opt-in dev-OTP echo — see the matching comment in
 * `identity.ts`. Never keyed off `NODE_ENV`, which nothing in this repo sets.
 */
const DEV_OTP_ECHO = process.env.ALLOW_DEV_OTP_ECHO === 'true';

/** POST /api/join/request-otp — body: { phone } — join path, no existing-match requirement. */
joinRouter.post('/request-otp', async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const { plainCode, expiresAt } = await createOtpCode(phone, 'JOIN');
    // No SMS integration exists; this is a stand-in until one is added.
    if (DEV_OTP_ECHO) {
      console.log(`[join] OTP for ${phone} (JOIN): ${plainCode} — dev echo enabled via ALLOW_DEV_OTP_ECHO.`);
    }

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: DEV_OTP_ECHO ? plainCode : undefined,
    });
  } catch (err) {
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
    const phone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    const fullName = req.body?.fullName ? String(req.body.fullName).trim() : null;
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required.' });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const result = await verifyOtpCode(phone, 'JOIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    // ALL normalized-digit matches, not the first: `phoneDigits` is lossy and
    // `User.phone` isn't unique, so two different real numbers can collide.
    // Auto-matching one of them would issue a session for the wrong person.
    const digits = phoneDigits(phone);
    const users = await prisma.user.findMany({ where: { locationId, isActive: true } });
    const matches = users.filter((u) => u.phone && phoneDigits(u.phone) === digits);
    if (matches.length > 1) {
      return res.status(409).json({ error: 'Multiple staff members match this phone number — contact support.' });
    }
    const match = matches[0];

    if (match) {
      const { plainToken, expiresAt } = await issueSession(match.id);
      return res.status(200).json({
        pending: false,
        token: plainToken,
        expiresAt: expiresAt.toISOString(),
        user: { id: match.id, fullName: match.fullName, jobTitle: match.jobTitle },
      });
    }

    if (!fullName) {
      return res.status(400).json({ error: 'No existing match — fullName is required to submit a join request for manual review.' });
    }
    const joinRequest = await prisma.joinRequest.create({
      data: { locationId, phone, fullName, status: 'PENDING' },
    });
    return res.status(201).json({ pending: true, joinRequestId: joinRequest.id });
  } catch (err) {
    console.error('[join.verifyOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while verifying the code.' });
  }
});

/** GET /api/join/:locationId/pending — list PENDING join requests for Pending Approvals. */
joinRouter.get('/:locationId/pending', async (req, res) => {
  try {
    const { locationId } = req.params;
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
 * PATCH /api/join/:requestId — body: { decision: 'approve'|'decline', reviewedById?, jobTitle? }
 * Approving creates a real, active User from the request's phone/fullName
 * and links it back onto the request — this is the one place a JoinRequest
 * ever produces a real staff member.
 */
joinRouter.patch('/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const decision = String(req.body?.decision ?? '');
    const reviewedById = req.body?.reviewedById ? String(req.body.reviewedById).trim() : null;
    if (decision !== 'approve' && decision !== 'decline') {
      return res.status(400).json({ error: 'decision must be "approve" or "decline".' });
    }

    const existing = await prisma.joinRequest.findUnique({ where: { id: requestId } });
    if (!existing) return res.status(404).json({ error: `Join request "${requestId}" not found.` });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'This request has already been reviewed.' });

    if (decision === 'decline') {
      await prisma.joinRequest.update({
        where: { id: requestId },
        data: { status: 'DECLINED', reviewedById, reviewedAt: new Date() },
      });
      await prisma.auditLog.create({
        data: { locationId: existing.locationId, actorId: reviewedById, action: 'JOIN_DECLINED', entityType: 'JoinRequest', entityId: requestId, note: `Declined join request for ${existing.fullName}` },
      });
      return res.status(200).json({ status: 'DECLINED' });
    }

    const jobTitle = req.body?.jobTitle ? String(req.body.jobTitle).trim() : null;
    const created = await prisma.user.create({
      data: { locationId: existing.locationId, fullName: existing.fullName, phone: existing.phone, jobTitle },
    });
    await prisma.joinRequest.update({
      where: { id: requestId },
      data: { status: 'APPROVED', reviewedById, reviewedAt: new Date(), createdUserId: created.id },
    });
    await prisma.auditLog.create({
      data: { locationId: existing.locationId, actorId: reviewedById, action: 'JOIN_APPROVED', entityType: 'JoinRequest', entityId: requestId, note: `Approved join request for ${existing.fullName} — created User ${created.id}` },
    });
    return res.status(200).json({ status: 'APPROVED', userId: created.id });
  } catch (err) {
    console.error('[join.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the join request.' });
  }
});
