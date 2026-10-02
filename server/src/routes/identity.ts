import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requestOtpCode, OtpRateLimitError, verifyOtpCode, issueSession, revokeSession } from '../lib/identity.js';
import { toE164, INVALID_PHONE_ERROR } from '../lib/phone.js';
import { otpRequestIpLimiter, sendOtpRateLimited } from '../middleware/rateLimit.js';
import { requireSession, bearerToken } from '../middleware/requireSession.js';
import { devOtpEchoFor, logDevOtpEcho } from '../lib/devOtpEcho.js';

export const identityRouter = Router();

/**
 * The active User with this phone, or null. `e164` must come from `toE164`:
 * `User.phone` is stored in E.164 and is unique, so this is one indexed lookup
 * (it used to scan every phone-bearing user and compare lossy digits).
 *
 * Deliberately GLOBAL, not location-scoped: login doesn't require knowing
 * which venue you belong to before you can request a code. You don't know
 * that up front from a `/login` redirect (see
 * `RequireSession` in `router.tsx`). Under Decision A1 (one User, one
 * Location) phone is the cross-venue identity key. signup.ts reuses this
 * for its "does this phone already have an account" check.
 */
export async function findActiveUserByPhone(e164: string) {
  const user = await findUserByPhone(e164);
  return user?.isActive ? user : null;
}

/**
 * The User holding this phone, active or not. The unique index covers
 * deactivated users too, so signup and join must check this one before
 * creating anything with the number, or the insert collides.
 */
export async function findUserByPhone(e164: string) {
  return prisma.user.findUnique({
    where: { phone: e164 },
    select: { id: true, phone: true, fullName: true, jobTitle: true, locationId: true, systemRole: true, isActive: true },
  });
}

/**
 * POST /api/identity/request-otp — body: { phone }
 * Login path: the phone must already match exactly one active User anywhere
 * in the system — no `locationId` needed up front, since the whole point of
 * logging back in is that the client doesn't necessarily know (or need to
 * know) which venue that is until after the phone resolves to a real account.
 */
identityRouter.post('/request-otp', otpRequestIpLimiter, async (req, res) => {
  try {
    const rawPhone = String(req.body?.phone ?? '').trim();
    if (!rawPhone) return res.status(400).json({ error: 'phone is required.' });
    const phone = toE164(rawPhone);
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_ERROR });

    if (!(await findActiveUserByPhone(phone))) {
      return res.status(404).json({ error: 'No active account found with that phone number.' });
    }

    const { plainCode, expiresAt } = await requestOtpCode(phone, 'LOGIN');
    // No SMS integration exists; this is a stand-in until one is added.
    const echo = devOtpEchoFor(phone);
    if (echo) logDevOtpEcho('identity', phone, 'LOGIN', plainCode);

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: echo ? plainCode : undefined,
    });
  } catch (err) {
    if (err instanceof OtpRateLimitError) return sendOtpRateLimited(res, err.scope, err.retryAfterSeconds);
    console.error('[identity.requestOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while requesting a code.' });
  }
});

/** POST /api/identity/verify-otp — body: { phone, code } */
identityRouter.post('/verify-otp', async (req, res) => {
  try {
    const rawPhone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    if (!rawPhone || !code) return res.status(400).json({ error: 'phone and code are required.' });
    const phone = toE164(rawPhone);
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_ERROR });

    const result = await verifyOtpCode(phone, 'LOGIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    const match = await findActiveUserByPhone(phone);
    if (!match) {
      return res.status(404).json({ error: 'No active account found with that phone number.' });
    }

    const { plainToken, expiresAt } = await issueSession(match.id);
    return res.status(200).json({
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
  } catch (err) {
    console.error('[identity.verifyOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while verifying the code.' });
  }
});

/**
 * DELETE /api/identity/session — sign out, revoking the session server-side.
 * Without this, "signing out" only cleared the browser's copy of the token
 * while the 30-day Session row stayed valid — a real problem on the shared
 * venue device this product is actually used on.
 */
identityRouter.delete('/session', requireSession, async (req, res) => {
  try {
    // requireSession already proved this header resolves to a real session.
    const token = bearerToken(req)!;
    await revokeSession(token);
    return res.status(204).send();
  } catch (err) {
    console.error('[identity.revokeSession] failed', err);
    return res.status(500).json({ error: 'Unexpected error while signing out.' });
  }
});
