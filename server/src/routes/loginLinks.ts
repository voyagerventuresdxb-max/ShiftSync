import { Router } from 'express';
import { requireSession } from '../middleware/requireSession.js';
import { loginLinkIssueRateLimiter, loginLinkRedeemRateLimiter } from '../middleware/rateLimit.js';
import { issueLoginLink, peekLoginLink, redeemLoginLink, revokeLoginLink, type LinkRejection } from '../lib/actions/loginLinkActions.js';
import { extractLoginLinkToken } from '../../../shared/loginLinks.js';

export const loginLinksRouter = Router();

const NOT_FOUND = 'That person could not be found.';

/** One message for every dead link — used, expired, revoked or never real — so the page never has to explain the difference. */
const REJECTED_MESSAGE = 'This link has already been used or has expired — ask your manager for a new one.';

function rejectedStatus(reason: LinkRejection): number {
  return reason === 'unknown' ? 404 : 410;
}

/**
 * POST /api/login-links — body: { userId }. Session-gated; who may target
 * whom is decided in loginLinkActions.findIssuableTarget and every refusal
 * is a 404. A STAFF session that is not a platform admin is refused
 * outright (403) before any lookup, since it can never issue to anyone.
 */
loginLinksRouter.post('/', requireSession, loginLinkIssueRateLimiter, async (req, res) => {
  try {
    if (req.user!.systemRole === 'STAFF' && !req.user!.isPlatformAdmin) {
      return res.status(403).json({ error: 'This action requires a manager or owner account.' });
    }
    const userId = String(req.body?.userId ?? '').trim();
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const outcome = await issueLoginLink(req.user!, userId);
    if (outcome.result === 'not_found') return res.status(404).json({ error: NOT_FOUND });
    return res.status(201).json({
      id: outcome.link.id,
      url: outcome.link.url,
      expiresAt: outcome.link.expiresAt.toISOString(),
      shareText: outcome.link.shareText,
    });
  } catch (err) {
    console.error('[loginLinks.issue] failed', err);
    return res.status(500).json({ error: 'Unexpected error while creating the login link.' });
  }
});

/** DELETE /api/login-links/:id — revoke. 404 for anything the caller could not have issued. */
loginLinksRouter.delete('/:id', requireSession, async (req, res) => {
  try {
    const outcome = await revokeLoginLink(req.user!, String(req.params.id));
    if (outcome === 'not_found') return res.status(404).json({ error: 'That login link could not be found.' });
    return res.status(204).send();
  } catch (err) {
    console.error('[loginLinks.revoke] failed', err);
    return res.status(500).json({ error: 'Unexpected error while revoking the login link.' });
  }
});

/**
 * POST /api/login-links/peek — body: { token }. Unauthenticated, read-only:
 * what the page shows before the Sign in tap ("Sign in as Ahmed — Il
 * Gattopardo"). Never consumes the link.
 */
loginLinksRouter.post('/peek', loginLinkRedeemRateLimiter, async (req, res) => {
  try {
    const token = extractLoginLinkToken(String(req.body?.token ?? ''));
    if (!token) return res.status(400).json({ error: "That doesn't look like a ShiftSync login link." });
    const outcome = await peekLoginLink(token);
    if (outcome.result === 'rejected') {
      return res.status(rejectedStatus(outcome.reason)).json({ error: REJECTED_MESSAGE, errorCode: `link_${outcome.reason}` });
    }
    return res.status(200).json({ fullName: outcome.fullName, venueName: outcome.venueName, expiresAt: outcome.expiresAt.toISOString() });
  } catch (err) {
    console.error('[loginLinks.peek] failed', err);
    return res.status(500).json({ error: 'Unexpected error while checking the login link.' });
  }
});

/**
 * POST /api/login-links/redeem — body: { token }. The ONLY call that spends
 * a link; the client makes it from the Sign in tap and nowhere else.
 */
loginLinksRouter.post('/redeem', loginLinkRedeemRateLimiter, async (req, res) => {
  try {
    const token = extractLoginLinkToken(String(req.body?.token ?? ''));
    if (!token) return res.status(400).json({ error: "That doesn't look like a ShiftSync login link." });
    const outcome = await redeemLoginLink(token, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
    if (outcome.result === 'rejected') {
      return res.status(rejectedStatus(outcome.reason)).json({ error: REJECTED_MESSAGE, errorCode: `link_${outcome.reason}` });
    }
    return res.status(200).json({
      token: outcome.token,
      expiresAt: outcome.expiresAt.toISOString(),
      user: outcome.user,
      landing: outcome.landing,
    });
  } catch (err) {
    console.error('[loginLinks.redeem] failed', err);
    return res.status(500).json({ error: 'Unexpected error while signing in.' });
  }
});
