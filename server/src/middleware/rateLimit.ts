import { rateLimit } from 'express-rate-limit';
import type { Request, Response } from 'express';

/**
 * Keys the limiter by the AUTHENTICATED SESSION (`req.user.id`), not raw IP.
 * MUST be mounted after `requireSession` — it reads `req.user`, which
 * `requireSession` is responsible for populating, and does not resolve a
 * session itself. Keying by user rather than IP matters specifically because
 * a shared venue device/IP (a tablet behind the host stand, a shared NAT)
 * must not let one heavy or abusive session lock out every other staff
 * member routing through the same address.
 */
function sessionKey(req: Request): string {
  // Defensive fallback only — in the intended mount order (after requireSession)
  // req.user is always populated by the time this runs. Falling back to req.ip
  // instead of throwing means a future mis-ordered mount degrades to a shared
  // per-IP bucket rather than a raw 500 leaking an internal error string.
  return req.user?.id ?? req.ip ?? 'unknown';
}

/**
 * Matches this codebase's existing error-response convention
 * (`res.status(...).json({ error: '...' })` — see voice.ts and sibling
 * route files) instead of express-rate-limit's default HTML/text 429 body.
 */
function sendTooManyRequests(_req: Request, res: Response): void {
  res.status(429).json({ error: 'Too many voice requests — please wait a few minutes and try again.' });
}

/**
 * Rate limit for POST /api/voice/transcribe (audio upload + Gemini/Whisper-
 * style transcription call — the more expensive of the two AI-backed voice
 * routes, both in payload size and provider processing cost). 20 requests
 * per 5 minutes comfortably covers real usage (a staff member firing off an
 * occasional voice command, including a few retries if a recording came out
 * garbled) while keeping the blast radius of a compromised/buggy client or
 * an abusive session small relative to a real per-provider-call cost.
 */
export const transcribeRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // A failed call (bad input, provider outage) shouldn't burn the same budget
  // as a successful one — otherwise a user retrying through a real Gemini
  // outage gets 429-locked out of the feature precisely when retries matter.
  skipFailedRequests: true,
  keyGenerator: sessionKey,
  handler: sendTooManyRequests,
});

/**
 * Rate limit for POST /api/voice/parse-intent (short text transcript ->
 * Gemini intent parsing — no audio payload, a smaller prompt, and a
 * schema-constrained response, so it is cheaper and faster per call than
 * /transcribe). A somewhat higher allowance is defensible on that basis, but
 * this deliberately stays in the same "occasional voice command" ballpark
 * rather than opening the door to materially more volume than /transcribe.
 */
export const parseIntentRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // A failed call (bad input, provider outage) shouldn't burn the same budget
  // as a successful one — otherwise a user retrying through a real Gemini
  // outage gets 429-locked out of the feature precisely when retries matter.
  skipFailedRequests: true,
  keyGenerator: sessionKey,
  handler: sendTooManyRequests,
});
