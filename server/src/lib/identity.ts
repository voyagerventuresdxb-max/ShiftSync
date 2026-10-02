import { randomInt, randomBytes, createHash } from 'node:crypto';
import { prisma } from './prisma.js';
import type { OtpPurpose, Prisma, User } from '@prisma/client';
import { toE164 } from './phone.js';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — long-lived, no refresh flow in this lightweight model
const MAX_OTP_ATTEMPTS = 5;

/**
 * Local-testing shortcut: when explicitly enabled, `DEV_OTP_BYPASS_CODE`
 * verifies successfully for ANY phone/purpose regardless of the real code on
 * file — skips needing `ALLOW_DEV_OTP_ECHO`'s real-code echo (or a live SMS
 * provider) just to click through login/join/signup locally.
 *
 * Fail-closed and explicitly opt-in, same rationale as `ALLOW_DEV_OTP_ECHO`
 * (see lib/devOtpEcho.ts): deliberately NOT keyed off `NODE_ENV`, because
 * nothing in this repo's scripts, Dockerfile or start command ever sets
 * `NODE_ENV=production` — that check would silently accept the fixed code in
 * every real deployment. Kept as its OWN flag rather than folded into
 * `ALLOW_DEV_OTP_ECHO`: echoing a just-generated code back to the person who
 * generated it is much lower-stakes than a fixed code that authenticates as
 * ANY phone number on file — someone should be able to enable one without
 * the other.
 */
const DEV_OTP_BYPASS = process.env.ALLOW_DEV_OTP_BYPASS === 'true';
export const DEV_OTP_BYPASS_CODE = '000000';

/** Thrown by the OTP functions below for a number `toE164` rejects. Routes check first and answer 400. */
export class InvalidPhoneError extends Error {
  constructor() {
    super('Invalid phone number');
    this.name = 'InvalidPhoneError';
  }
}

/** The E.164 form every OTP row is keyed on, whatever format the caller passed. */
function otpPhone(phone: string): string {
  const e164 = toE164(phone);
  if (!e164) throw new InvalidPhoneError();
  return e164;
}

/** Real 6-digit numeric code. Only ever logged/returned for allowlisted numbers (lib/devOtpEcho.ts). */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** sha256 hex digest — codes and session tokens are never stored in plaintext. */
export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Creates and stores a new OTP for (phone, purpose), invalidating any prior
 * unconsumed code for the same (phone, purpose) pair so only the most
 * recently requested code is ever valid.
 *
 * `OtpCode.phone` is stored in E.164 (via `toE164`), not the raw submitted
 * string, so a code requested as "+971 50 123 4567" can be verified as
 * "0501234567", the same way `User.phone` is stored and matched.
 */
export async function createOtpCode(
  phone: string,
  purpose: OtpPurpose,
  db: Prisma.TransactionClient = prisma,
): Promise<{ id: string; plainCode: string; expiresAt: Date }> {
  const normalizedPhone = otpPhone(phone);
  await db.otpCode.updateMany({
    where: { phone: normalizedPhone, purpose, consumedAt: null },
    data: { consumedAt: new Date() }, // invalidate — not a real "use," just supersession
  });
  const plainCode = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const created = await db.otpCode.create({
    data: { phone: normalizedPhone, purpose, codeHash: hashOtp(plainCode), expiresAt },
  });
  return { id: created.id, plainCode, expiresAt };
}

/**
 * Caps on minting new codes, counted from `OtpCode` rows (so they survive
 * restarts and deploys, unlike an in-memory limiter). Per phone, ACROSS all
 * three purposes — otherwise one number could take 3x the cap by rotating
 * login/join/signup. Once a real SMS provider exists (#51) every code is a
 * paid message, so these are also the main defence against SMS pumping
 * (strangers triggering texts to numbers they pick, at our cost).
 */
const OTP_PHONE_LIMITS = [
  { windowMs: 30 * 1000, max: 1 }, // one resend per 30s
  { windowMs: 60 * 60 * 1000, max: 5 },
  { windowMs: 24 * 60 * 60 * 1000, max: 10 },
];
/** Circuit breaker across ALL phones: a distributed attack rotating numbers still stops here. */
const OTP_GLOBAL_LIMIT = { windowMs: 60 * 60 * 1000, max: 500 };
const OTP_GLOBAL_RETRY_SECONDS = 5 * 60;

export class OtpRateLimitError extends Error {
  constructor(
    public readonly scope: 'phone' | 'global',
    public readonly retryAfterSeconds: number,
  ) {
    super(`OTP rate limit (${scope})`);
    this.name = 'OtpRateLimitError';
  }
}

/**
 * Seconds until `rows` (createdAt, newest first) is back under every limit,
 * or 0 if it already is. For a rule with max N, the Nth-newest row in its
 * window is the one that has to age out before another request fits.
 */
export function otpPhoneRetryAfterSeconds(createdAt: Date[], now: Date): number {
  let waitMs = 0;
  for (const { windowMs, max } of OTP_PHONE_LIMITS) {
    const inWindow = createdAt.filter((t) => now.getTime() - t.getTime() < windowMs);
    if (inWindow.length >= max) {
      waitMs = Math.max(waitMs, inWindow[max - 1]!.getTime() + windowMs - now.getTime());
    }
  }
  return Math.ceil(waitMs / 1000);
}

/**
 * The ONLY way the request-otp routes may mint a code: enforces the caps
 * above, then creates it. Throws `OtpRateLimitError` when over a cap.
 * (`createOtpCode` itself stays unthrottled for tests that need a code.)
 *
 * Runs under a per-phone advisory lock, so two concurrent requests for the
 * same number can't both read "under the cap" and both create a code.
 */
export async function requestOtpCode(
  phone: string,
  purpose: OtpPurpose,
): Promise<{ id: string; plainCode: string; expiresAt: Date }> {
  const normalizedPhone = otpPhone(phone);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp:${normalizedPhone}`}))::text`;
    const now = new Date();
    const longestWindowMs = Math.max(...OTP_PHONE_LIMITS.map((l) => l.windowMs));
    const recent = await tx.otpCode.findMany({
      where: { phone: normalizedPhone, createdAt: { gt: new Date(now.getTime() - longestWindowMs) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
      take: Math.max(...OTP_PHONE_LIMITS.map((l) => l.max)),
    });
    const retryAfter = otpPhoneRetryAfterSeconds(recent.map((r) => r.createdAt), now);
    if (retryAfter > 0) throw new OtpRateLimitError('phone', retryAfter);

    const globalCount = await tx.otpCode.count({
      where: { createdAt: { gt: new Date(now.getTime() - OTP_GLOBAL_LIMIT.windowMs) } },
    });
    if (globalCount >= OTP_GLOBAL_LIMIT.max) throw new OtpRateLimitError('global', OTP_GLOBAL_RETRY_SECONDS);

    return createOtpCode(phone, purpose, tx);
  });
}

/**
 * Verifies a submitted code against the most recent unconsumed OTP for
 * (phone, purpose). Consumes it (success or failure) so a code can never be
 * replayed, and rate-limits guesses via `attempts`.
 */
export async function verifyOtpCode(
  phone: string,
  purpose: OtpPurpose,
  submittedCode: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (DEV_OTP_BYPASS && submittedCode === DEV_OTP_BYPASS_CODE) return { ok: true };

  // Look up on the same normalized digits `createOtpCode` stored (see there).
  const record = await prisma.otpCode.findFirst({
    where: { phone: otpPhone(phone), purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) return { ok: false, reason: 'No active code for this phone number — request a new one.' };
  if (record.expiresAt < new Date()) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    return { ok: false, reason: 'That code has expired — request a new one.' };
  }
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    return { ok: false, reason: 'Too many incorrect attempts — request a new code.' };
  }
  if (hashOtp(submittedCode) !== record.codeHash) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: 'Incorrect code.' };
  }
  await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
  return { ok: true };
}

/** Issues a new bearer session token for a real, already-verified User. */
export async function issueSession(userId: string): Promise<{ plainToken: string; expiresAt: Date }> {
  const plainToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { userId, tokenHash: hashOtp(plainToken), expiresAt },
  });
  return { plainToken, expiresAt };
}

/**
 * Deletes the Session row backing a bearer token, ending it server-side.
 * Idempotent: a token that resolves to no row (already revoked, expired and
 * cleaned up, or never valid) is a silent no-op rather than an error — a
 * sign-out must never fail just because there was nothing left to sign out of.
 */
export async function revokeSession(plainToken: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashOtp(plainToken) } });
}

/** Resolves a bearer token to its real User, or null if missing/expired/unknown. */
export async function resolveSession(plainToken: string): Promise<User | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashOtp(plainToken) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}
