import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
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
  // req.user is always populated by the time this runs. Falling back to a
  // per-IP bucket (via express-rate-limit's own IPv6-safe helper, not raw
  // req.ip — a raw string lets an IPv6 client bypass the limit by rotating
  // the low bits of its address) means a future mis-ordered mount degrades
  // gracefully instead of throwing a raw 500 that leaks an internal error.
  return req.user?.id ?? ipKeyGenerator(req.ip ?? '');
}

/**
 * Matches this codebase's existing error-response convention
 * (`res.status(...).json({ error: '...' })` — see voice.ts and sibling
 * route files) instead of express-rate-limit's default HTML/text 429 body.
 */
function sendTooManyRequests(_req: Request, res: Response): void {
  res.status(429).json({ error: 'Too many requests — please wait a few minutes and try again.' });
}

function describeWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.ceil(minutes / 60)} hours`;
}

/**
 * The request-otp routes' 429 for `OtpRateLimitError` (thrown by
 * `requestOtpCode`): same JSON shape as `sendTooManyRequests`, plus
 * `Retry-After`. The frontend shows `error` as-is, so the wait is in the text.
 */
export function sendOtpRateLimited(res: Response, scope: 'phone' | 'global', retryAfterSeconds: number): void {
  res.set('Retry-After', String(retryAfterSeconds));
  const error =
    scope === 'phone'
      ? `Too many code requests for this number — try again in ${describeWait(retryAfterSeconds)}.`
      : 'Sign-in codes are temporarily unavailable — please try again in a few minutes.';
  res.status(429).json({ error });
}

/**
 * Shared shape for every session-keyed, AI-provider-backed route limiter
 * (voice transcription/intent parsing, roster-upload vision extraction, and
 * any future Gemini/Whisper-style route) — only `limit` and `skipFailedRequests`
 * vary per route. Not voice-specific: this is the general per-user "guard an
 * expensive external AI call" factory for this codebase.
 *
 * `skipFailedRequests` is NOT safe to hardcode `true` for every caller: it
 * only makes sense where a >=400 response means "the provider call never
 * really happened, or the provider itself is down" (voice.ts's two routes
 * only ever fail with a 503 VOICE_UNAVAILABLE from a genuine provider
 * outage). schedules.ts's upload route is different — a malformed/
 * low-quality file routinely returns 422 AFTER a real, paid Gemini or local
 * Ollama vision call already ran and simply couldn't extract a usable
 * roster. Defaulting `skipFailedRequests` to true there would let repeated
 * bad uploads dodge the counter entirely while still spending the real
 * per-call cost this limiter exists to cap — so each call site must pass an
 * explicit value, not inherit a blanket default.
 */
function makeAiRouteLimiter(limit: number, skipFailedRequests: boolean) {
  return rateLimit({
    windowMs: 5 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests,
    keyGenerator: sessionKey,
    handler: sendTooManyRequests,
  });
}

/**
 * POST /api/voice/transcribe (audio upload + Gemini/Whisper-style
 * transcription call — the more expensive of the two AI-backed voice
 * routes, both in payload size and provider processing cost). 20 requests
 * per 5 minutes comfortably covers real usage (a staff member firing off an
 * occasional voice command, including a few retries if a recording came out
 * garbled) while keeping the blast radius of a compromised/buggy client or
 * an abusive session small relative to a real per-provider-call cost.
 * `skipFailedRequests: true` — this route's only failure mode is a 503 from
 * a genuine Gemini/Whisper outage, so a retrying user shouldn't burn budget
 * on a call that never really completed.
 */
export const transcribeRateLimiter = makeAiRouteLimiter(20, true);

/**
 * POST /api/voice/parse-intent (short text transcript -> Gemini intent
 * parsing — no audio payload, a smaller prompt, and a schema-constrained
 * response, so it is cheaper and faster per call than /transcribe). A
 * somewhat higher allowance is defensible on that basis, but this
 * deliberately stays in the same "occasional voice command" ballpark
 * rather than opening the door to materially more volume than /transcribe.
 * `skipFailedRequests: true` for the same reason as /transcribe above.
 */
export const parseIntentRateLimiter = makeAiRouteLimiter(30, true);

/**
 * POST /api/voice/execute: one confirmed voice command per call, no model call. 30 per 5 minutes per
 * session (the same allowance as /parse-intent, since every execute follows a parse) caps a
 * scripted client hammering the write path with hand-built bodies. Every request counts,
 * refusals included: a refused body is exactly what such a client sends.
 */
export const voiceExecuteRateLimiter = makeAiRouteLimiter(30, false);

/** POST /api/ai/self-test: two tiny real model calls per request, so a handful per 5 minutes. Every request counts. */
export const aiSelfTestRateLimiter = makeAiRouteLimiter(3, false);

/**
 * POST /api/schedules/upload (roster file upload — schedules.ts routes an
 * uploaded file across several parsing paths depending on shape: a
 * deterministic grid/text parser first where possible, a local Ollama vision
 * model for images and scanned/no-text-layer PDFs, and — for an Excel/CSV
 * grid the deterministic parser can't recognize — a last-resort call to
 * parseVision.ts's parseRosterGrid, which hits the Gemini API directly for
 * full-page grid reconstruction, anomaly detection, and leave-record
 * extraction in one shot). Whichever path a given upload takes, the request
 * itself is a full file (image/PDF/spreadsheet), a materially larger payload
 * than /transcribe's audio, and every non-deterministic path is a more
 * expensive extraction call than a single transcription. It is also a far
 * rarer legitimate action than a voice command: a manager uploads a roster
 * once per scheduling cycle, plus maybe a couple of retries if a scan came
 * out cropped wrong or the wrong file got picked. 10 requests per 5 minutes
 * is deliberately tighter than /transcribe's 20 — reflecting the higher
 * per-call cost on the paths that do hit an external/local AI model — while
 * still leaving comfortable headroom over any realistic legitimate retry
 * burst. `skipFailedRequests: false` — unlike voice.ts's routes, a 422 here
 * (`VisionIngestionError`/`PdfRasterizeError`) routinely follows a real,
 * already-spent Gemini or Ollama call that just couldn't extract a usable
 * roster from a bad file; excluding those from the counter would let
 * repeated bad uploads dodge the limit while still paying the real
 * per-call cost this limiter exists to cap.
 */
export const rosterUploadRateLimiter = makeAiRouteLimiter(10, false);

/** One header value as an ipKeyGenerator-normalised key part (first entry of a list, length-capped). */
function ipPart(value: string): string {
  return ipKeyGenerator(value.split(',')[0]!.trim().slice(0, 64));
}

function isLoopback(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

/**
 * Who is asking for a code, as measured on production on 2026-10-01 (#54),
 * not as either vendor's docs describe it:
 * - Railway's edge OVERWRITES `X-Real-IP` with the address that connected to
 *   it (a forged value never survives), so that half can't be faked.
 * - Through Vercel's `/api` rewrite, that connecting address is VERCEL's, the
 *   same for many users. The real client is in `X-Vercel-Forwarded-For`,
 *   which Vercel overwrites, so it can't be forged through Vercel. But the
 *   Railway domain is public, and a caller going there directly can send any
 *   `X-Vercel-Forwarded-For` they like (it passes through untouched).
 * So the key is the PAIR. Real users through Vercel each get their own
 * bucket, and nobody can land in someone else's, because a direct caller's
 * first half is always their own real address. A direct caller can dodge
 * this limit by rotating the second half; the per-phone and global caps in
 * `requestOtpCode` still hold for them.
 *
 * `trust proxy` stays unset on purpose: nothing here reads `req.ip`, which
 * would depend on Railway's internal hop count instead of one explicit header.
 *
 * Returns null for a loopback request with no `X-Real-IP` (local dev and e2e,
 * no proxy in front). That can't happen on Railway, which always sets it.
 */
export function otpClientKey(req: Request): string | null {
  const connecting = req.get('x-real-ip');
  if (!connecting) {
    const remote = req.socket.remoteAddress ?? '';
    return isLoopback(remote) ? null : ipPart(remote);
  }
  const claimed = req.get('x-vercel-forwarded-for');
  return claimed ? `${ipPart(connecting)}|${ipPart(claimed)}` : ipPart(connecting);
}

/**
 * Per-client cap on the three request-otp routes (one shared instance, so
 * the count is shared across login/join/signup): 10 per 15 minutes. Mostly
 * slows enumeration (login answers 404 for a number with no account) and a
 * single client spraying numbers; the per-phone and global caps stop SMS
 * pumping. In-memory store, so it resets on deploy (the DB-backed caps don't).
 */
export const otpRequestIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => otpClientKey(req) === null,
  keyGenerator: (req) => otpClientKey(req)!,
  // We read X-Real-IP / X-Vercel-Forwarded-For ourselves, so express-rate-limit's
  // "X-Forwarded-For present but trust proxy unset" warning doesn't apply.
  validate: { xForwardedForHeader: false },
  handler: sendTooManyRequests,
});

/** GET /api/join/invite/:token: 60 per 15 minutes per client, keyed and loopback-skipped like `otpRequestIpLimiter`. */
export const invitePeekLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => otpClientKey(req) === null,
  keyGenerator: (req) => otpClientKey(req)!,
  validate: { xForwardedForHeader: false },
  handler: sendTooManyRequests,
});

/** Per-client limiter keyed and loopback-skipped like `otpRequestIpLimiter`. */
function clientKeyedLimiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => otpClientKey(req) === null,
    keyGenerator: (req) => otpClientKey(req)!,
    validate: { xForwardedForHeader: false },
    handler: sendTooManyRequests,
  });
}

/** POST /api/login-links (issue): 10 per hour per session. Mount after `requireSession`. */
export const loginLinkIssueRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: sessionKey,
  handler: sendTooManyRequests,
});

/** POST /api/login-links/redeem: 30 per 10 minutes per client. */
export const loginLinkRedeemRateLimiter = clientKeyedLimiter(10 * 60 * 1000, 30);

/** POST /api/login-links/peek: its own bucket (60 per 10 minutes) so every sign-in's peek doesn't halve redeem capacity. */
export const loginLinkPeekRateLimiter = clientKeyedLimiter(10 * 60 * 1000, 60);

/**
 * Refused kiosk reads (no session; `X-Kiosk-Token` missing, wrong, replaced or
 * revoked): 20 per 15 minutes per client, keyed and loopback-skipped like
 * `otpRequestIpLimiter`. middleware/kioskAccess.ts calls it only on a refusal,
 * so it counts failures alone, and a valid token or a session never reaches it.
 */
export const kioskFailureLimiter = clientKeyedLimiter(15 * 60 * 1000, 20);
