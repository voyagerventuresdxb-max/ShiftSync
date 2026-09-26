import { Router } from 'express';
import { createOtpCode, verifyOtpCode, issueSession, revokeSession } from '../lib/identity.js';
import { requireSession, bearerToken } from '../middleware/requireSession.js';
import { otpRequestRateLimiters, otpVerifyRateLimiters } from '../middleware/rateLimit.js';
import { requireOtpEnabled } from '../middleware/requireOtpEnabled.js';
import { loginMethods } from '../lib/loginLinks.js';
import { devOtpEchoEnabled, logDevOtpEcho } from '../lib/devOtpEcho.js';

export const identityRouter = Router();

// `findPhoneMatches` moved to lib/identity.ts (2026-09-26) so the CLI scripts
// and lib/actions can use it without importing a route module; re-exported
// here for signup.ts.
import { findPhoneMatches } from '../lib/identity.js';
export { findPhoneMatches };

const AMBIGUOUS_MATCH_ERROR = 'Multiple staff members match this phone number — contact support.';

/**
 * GET /api/identity/config — public. Tells the client which front doors
 * exist (see lib/loginLinks.ts LOGIN_METHODS) so it can hide the phone-code
 * screens in links-only mode instead of showing a form that would 403.
 */
identityRouter.get('/config', (_req, res) => {
  return res.status(200).json({ loginMethods: loginMethods() });
});

/**
 * POST /api/identity/request-otp — body: { phone }
 * Login path: the phone must already match exactly one active User anywhere
 * in the system — no `locationId` needed up front, since the whole point of
 * logging back in is that the client doesn't necessarily know (or need to
 * know) which venue that is until after the phone resolves to a real account.
 */
identityRouter.post('/request-otp', requireOtpEnabled, ...otpRequestRateLimiters, async (req, res) => {
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
identityRouter.post('/verify-otp', requireOtpEnabled, ...otpVerifyRateLimiters, async (req, res) => {
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
