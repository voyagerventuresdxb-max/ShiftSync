import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { createOtpCode, verifyOtpCode, issueSession, revokeSession, phoneDigits } from '../lib/identity.js';
import { requireSession, bearerToken } from '../middleware/requireSession.js';
import { otpRequestRateLimiters, otpVerifyRateLimiters } from '../middleware/rateLimit.js';
import { devOtpEchoEnabled, logDevOtpEcho } from '../lib/devOtpEcho.js';

export const identityRouter = Router();

/**
 * Finds active users anywhere in the system whose stored phone normalizes to
 * the same digits as `phone`. Returns ALL matches, because `phoneDigits` is
 * lossy (it strips leading `971`/`0`) and `User.phone` has no unique
 * constraint at the DB level yet — two genuinely different numbers can
 * normalize to the same digits, and silently picking the first would hand
 * one person another person's session.
 *
 * Deliberately GLOBAL, not location-scoped: login no longer requires knowing
 * which venue you belong to before you can even request a code — you don't
 * know that up front from a bare `/join?mode=login` redirect (see
 * `RequireSession` in `router.tsx`, and the real bug this fixed: it redirects
 * a signed-out visit with no location context at all, so a login flow that
 * required one couldn't be reached). Matches `server/src/routes/signup.ts`'s
 * own global, unscoped phone lookup — both now treat phone as the real
 * cross-venue identity key, consistent with Decision A1 (one User, one
 * Location, phone intended to be globally unique — a DB-level unique
 * constraint on `User.phone` is a separate, still-pending, explicitly
 * user-gated migration; this is the application-layer half of that same
 * model, already necessary regardless of when that migration lands).
 */
// Exported so signup.ts's own global "does this phone already have an
// account" check reuses this instead of re-implementing the same lossy
// digits-filter a second time — one lookup, one place to fix if phone
// normalization ever changes. Selects only the fields either caller actually
// needs (not full rows) — this scans every active phone-bearing User in the
// system on every login attempt now that it's global, not location-scoped,
// so keeping each row cheap matters more than it did before.
export async function findPhoneMatches(phone: string) {
  const digits = phoneDigits(phone);
  const users = await prisma.user.findMany({
    where: { isActive: true, phone: { not: null } },
    select: { id: true, phone: true, fullName: true, jobTitle: true, locationId: true, systemRole: true },
  });
  return users.filter((u) => u.phone && phoneDigits(u.phone) === digits);
}

const AMBIGUOUS_MATCH_ERROR = 'Multiple staff members match this phone number — contact support.';

/**
 * POST /api/identity/request-otp — body: { phone }
 * Login path: the phone must already match exactly one active User anywhere
 * in the system — no `locationId` needed up front, since the whole point of
 * logging back in is that the client doesn't necessarily know (or need to
 * know) which venue that is until after the phone resolves to a real account.
 */
identityRouter.post('/request-otp', ...otpRequestRateLimiters, async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const matches = await findPhoneMatches(phone);
    if (matches.length === 0) {
      return res.status(404).json({ error: 'No active account found with that phone number.' });
    }
    if (matches.length > 1) return res.status(409).json({ error: AMBIGUOUS_MATCH_ERROR });

    const { plainCode, expiresAt } = await createOtpCode(phone, 'LOGIN');
    // No SMS integration exists; this is a stand-in until one is added.
    const echo = devOtpEchoEnabled();
    if (echo) logDevOtpEcho('identity', phone, 'LOGIN', plainCode);

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: echo ? plainCode : undefined,
    });
  } catch (err) {
    console.error('[identity.requestOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while requesting a code.' });
  }
});

/** POST /api/identity/verify-otp — body: { phone, code } */
identityRouter.post('/verify-otp', ...otpVerifyRateLimiters, async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required.' });

    const result = await verifyOtpCode(phone, 'LOGIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    const matches = await findPhoneMatches(phone);
    if (matches.length === 0) {
      return res.status(404).json({ error: 'No active account found with that phone number.' });
    }
    if (matches.length > 1) return res.status(409).json({ error: AMBIGUOUS_MATCH_ERROR });
    const match = matches[0]!;

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
