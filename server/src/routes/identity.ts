import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requestOtpCode, OtpRateLimitError, verifyOtpCode, issueSession, revokeSession } from '../lib/identity.js';
import { toE164, INVALID_PHONE_ERROR } from '../lib/phone.js';
import { otpRequestIpLimiter, sendOtpRateLimited } from '../middleware/rateLimit.js';
import { requireSession, bearerToken } from '../middleware/requireSession.js';
import { requireOtpEnabled } from '../middleware/requireOtpEnabled.js';
import { loginMethods } from '../lib/loginLinks.js';
import { devOtpEchoFor, logDevOtpEcho } from '../lib/devOtpEcho.js';
import { getApproverNameForLocation } from '../lib/managers.js';
import { joinDeclinedMessage } from '../lib/actions/joinActions.js';

export const identityRouter = Router();

/** GET /api/identity/config — public: which sign-in methods are on (lib/loginLinks.ts `loginMethods`). */
identityRouter.get('/config', (_req, res) => {
  return res.status(200).json({ loginMethods: loginMethods() });
});

const NO_ACCOUNT_ERROR = 'No active account found with that phone number.';

/**
 * The User holding this phone, active or not. The unique index covers
 * deactivated users too, so signup and join must check this one before
 * creating anything with the number, or the insert collides.
 *
 * Deliberately GLOBAL, not location-scoped: login doesn't require knowing
 * which venue you belong to before you can request a code. You don't know
 * that up front from a `/login` redirect (see
 * `RequireSession` in `router.tsx`). Under Decision A1 (one User, one
 * Location) phone is the cross-venue identity key. `e164` must come from
 * `toE164`: `User.phone` is stored in E.164, so this is one indexed lookup.
 */
export async function findUserByPhone(e164: string) {
  return prisma.user.findUnique({
    where: { phone: e164 },
    select: { id: true, phone: true, fullName: true, jobTitle: true, locationId: true, systemRole: true, isActive: true },
  });
}

/**
 * POST /api/identity/request-otp — body: { phone }
 * Login path: the phone must already match a User (active or deactivated) or
 * a PENDING/DECLINED JoinRequest — no `locationId` needed up front, since the whole point of
 * logging back in is that the client doesn't necessarily know (or need to
 * know) which venue that is until after the phone resolves to a real account.
 */
identityRouter.post('/request-otp', requireOtpEnabled, otpRequestIpLimiter, async (req, res) => {
  try {
    const rawPhone = String(req.body?.phone ?? '').trim();
    if (!rawPhone) return res.status(400).json({ error: 'phone is required.' });
    const phone = toE164(rawPhone);
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_ERROR });

    // Deactivated staff and pending/declined applicants get a code too; their status is only revealed after verify.
    const known =
      (await findUserByPhone(phone)) ??
      (await prisma.joinRequest.findFirst({ where: { phone, status: { in: ['PENDING', 'DECLINED'] } }, select: { id: true } }));
    if (!known) {
      return res.status(404).json({ error: NO_ACCOUNT_ERROR });
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

/**
 * POST /api/identity/verify-otp — body: { phone, code }
 * Active user → session. Otherwise, only after the code checks out: pending
 * applicant → 200 `{ pending: true, status, venueName, managerName }` (no
 * token); deactivated or declined → 403 `{ status, venueName, error }`.
 */
identityRouter.post('/verify-otp', requireOtpEnabled, async (req, res) => {
  try {
    const rawPhone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    if (!rawPhone || !code) return res.status(400).json({ error: 'phone and code are required.' });
    const phone = toE164(rawPhone);
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_ERROR });

    const result = await verifyOtpCode(phone, 'LOGIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    const match = await findUserByPhone(phone);
    if (match && !match.isActive) {
      const { name: venueName } = await prisma.location.findUniqueOrThrow({ where: { id: match.locationId }, select: { name: true } });
      return res.status(403).json({
        status: 'deactivated',
        venueName,
        error: `Your staff account at ${venueName} has been deactivated. Ask a manager there to reactivate it.`,
      });
    }
    if (!match) {
      // An open application wins over an old declined one (e.g. declined at one venue, applied to another).
      const include = { location: { select: { name: true } } } as const;
      const pending = await prisma.joinRequest.findFirst({ where: { phone, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, include });
      if (pending) {
        return res.status(200).json({
          pending: true,
          status: 'pending',
          venueName: pending.location.name,
          managerName: await getApproverNameForLocation(pending.locationId),
        });
      }
      const declined = await prisma.joinRequest.findFirst({ where: { phone, status: 'DECLINED' }, orderBy: { createdAt: 'desc' }, include });
      if (declined) {
        return res.status(403).json({ status: 'declined', venueName: declined.location.name, error: joinDeclinedMessage(declined.location.name) });
      }
      return res.status(404).json({ error: NO_ACCOUNT_ERROR });
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
