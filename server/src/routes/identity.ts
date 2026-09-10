import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { createOtpCode, verifyOtpCode, issueSession, revokeSession, phoneDigits } from '../lib/identity.js';
import { requireSession, bearerToken } from '../middleware/requireSession.js';

export const identityRouter = Router();

/**
 * The dev-OTP echo is FAIL-CLOSED and opt-in: it is only ever enabled when
 * `ALLOW_DEV_OTP_ECHO` is explicitly set to 'true'. It deliberately does NOT
 * key off `NODE_ENV`, because nothing in this repo's scripts, Dockerfile or
 * start command ever sets `NODE_ENV=production` — a `NODE_ENV !== 'production'`
 * check would therefore leak every real OTP by default. Gate both the HTTP
 * echo and the plaintext server-log line on this one flag.
 */
const DEV_OTP_ECHO = process.env.ALLOW_DEV_OTP_ECHO === 'true';

/**
 * Finds active users at a location whose stored phone normalizes to the same
 * digits as `phone`. Returns ALL matches, because `phoneDigits` is lossy
 * (it strips leading `971`/`0`) and `User.phone` has no unique constraint —
 * two genuinely different numbers can normalize to the same digits, and
 * silently picking the first would hand one person another person's session.
 */
async function findPhoneMatches(locationId: string, phone: string) {
  const digits = phoneDigits(phone);
  const users = await prisma.user.findMany({ where: { locationId, isActive: true } });
  return users.filter((u) => u.phone && phoneDigits(u.phone) === digits);
}

const AMBIGUOUS_MATCH_ERROR = 'Multiple staff members match this phone number — contact support.';

/**
 * POST /api/identity/request-otp — body: { locationId, phone }
 * Login path: the phone must already match exactly one active User at the
 * given location. `locationId` is required (and FK-validated) so a lookup is
 * never unscoped across every venue in the database.
 */
identityRouter.post('/request-otp', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const matches = await findPhoneMatches(locationId, phone);
    if (matches.length === 0) {
      return res.status(404).json({ error: 'No active staff member found with that phone number.' });
    }
    if (matches.length > 1) return res.status(409).json({ error: AMBIGUOUS_MATCH_ERROR });

    const { plainCode, expiresAt } = await createOtpCode(phone, 'LOGIN');
    // No SMS integration exists; this is a stand-in until one is added.
    if (DEV_OTP_ECHO) {
      console.log(`[identity] OTP for ${phone} (LOGIN): ${plainCode} — dev echo enabled via ALLOW_DEV_OTP_ECHO.`);
    }

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: DEV_OTP_ECHO ? plainCode : undefined,
    });
  } catch (err) {
    console.error('[identity.requestOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while requesting a code.' });
  }
});

/** POST /api/identity/verify-otp — body: { locationId, phone, code } */
identityRouter.post('/verify-otp', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required.' });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const result = await verifyOtpCode(phone, 'LOGIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    const matches = await findPhoneMatches(locationId, phone);
    if (matches.length === 0) {
      return res.status(404).json({ error: 'No active staff member found with that phone number.' });
    }
    if (matches.length > 1) return res.status(409).json({ error: AMBIGUOUS_MATCH_ERROR });
    const match = matches[0]!;

    const { plainToken, expiresAt } = await issueSession(match.id);
    return res.status(200).json({
      token: plainToken,
      expiresAt: expiresAt.toISOString(),
      user: { id: match.id, fullName: match.fullName, jobTitle: match.jobTitle },
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
