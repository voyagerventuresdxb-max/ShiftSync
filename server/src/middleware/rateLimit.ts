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

/**
 * OTP routes are UNAUTHENTICATED (they are how a session is obtained), so
 * the session-keyed factory above can't guard them. Two limiters run in
 * sequence on each of the six request-otp / verify-otp routes:
 *
 *  - per PHONE (normalized via `phoneDigits`, the same key the OtpCode row
 *    uses) — stops one number being hammered from many addresses, and caps
 *    how many real codes (someday real SMS spend) one number can trigger;
 *  - per IP — stops one address rotating phone numbers to enumerate which
 *    ones have accounts (identity/request-otp answers 404 vs 200) or to
 *    brute-force codes across many numbers.
 *
 * Both fail closed on a missing/blank phone by falling back to the IP key,
 * so a body-less request still counts against something. Windows are 10
 * minutes: long enough that a guess loop is slow, short enough that a real
 * person who mistyped their number twice isn't locked out for the shift.
 * Successful requests count too — a "success" here is a real code minted or
 * a real session issued, exactly the thing to cap.
 *
 * Sizing: a legitimate login is request → (maybe re-request) → verify, once
 * every 30 days per person (sessions are 30-day). 5 request-otp per phone
 * covers a re-request or two; 10 verify-otp per phone is two full codes'
 * worth of `MAX_OTP_ATTEMPTS`. Per IP, 30/60 leaves headroom for a venue
 * where a whole team behind one NAT signs in on the same morning. Behind a
 * reverse proxy (Railway, Vercel's rewrite) `req.ip` is only the real client
 * when `app.set('trust proxy', …)` is configured — see app.ts / TRUST_PROXY.
 */
const OTP_WINDOW_MS = 10 * 60 * 1000;

function otpPhoneKey(req: Request): string {
  const raw = typeof req.body?.phone === 'string' ? req.body.phone : '';
  const digits = raw.replace(/\D/g, '').replace(/^00/, '').replace(/^971/, '').replace(/^0/, '');
  return digits ? `phone:${digits}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

function otpIpKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

function makeOtpLimiter(limit: number, keyGenerator: (req: Request) => string) {
  return rateLimit({
    windowMs: OTP_WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: false,
    keyGenerator,
    handler: sendTooManyRequests,
  });
}

/** Mount on every POST …/request-otp: per IP first (cheapest key), then per phone. */
export const otpRequestRateLimiters = [makeOtpLimiter(30, otpIpKey), makeOtpLimiter(5, otpPhoneKey)];

/** Mount on every POST …/verify-otp. */
export const otpVerifyRateLimiters = [makeOtpLimiter(60, otpIpKey), makeOtpLimiter(10, otpPhoneKey)];

/**
 * Login links (routes/loginLinks.ts).
 *  - Issuing is session-keyed (a manager minting links for their staff):
 *    10 per hour is a whole team's worth of re-sends, and far below what a
 *    compromised manager session could use to spam WhatsApp with.
 *  - Peek/redeem are unauthenticated (they are how a session is obtained),
 *    so per IP like the OTP routes: 30 per 10 minutes covers a venue's staff
 *    signing in from one NAT on the same morning; a token is 256 random
 *    bits, so this is about noise, not brute force.
 */
export const loginLinkIssueRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: false,
  keyGenerator: sessionKey,
  handler: sendTooManyRequests,
});

export const loginLinkRedeemRateLimiter = makeOtpLimiter(30, otpIpKey);
