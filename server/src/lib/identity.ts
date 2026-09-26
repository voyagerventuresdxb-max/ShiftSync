import { randomInt, randomBytes, createHash } from 'node:crypto';
import { prisma } from './prisma.js';
import type { OtpPurpose, User } from '@prisma/client';

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
 * (see routes/identity.ts): deliberately NOT keyed off `NODE_ENV`, because
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

/**
 * Digits only, dropping a leading international-dialing prefix so
 * "+971 50 123 4567", "00971501234567", and "0501234567" can all match the
 * same stored number. Shared by identity.ts (login) and join.ts
 * (self-registration) so phone matching stays consistent between the two.
 */
export function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const withoutIntlPrefix = digits.replace(/^00/, '').replace(/^971/, '');
  return withoutIntlPrefix.replace(/^0/, '');
}

/** Real 6-digit numeric code. Never logged/returned in production (see the request-otp routes). */
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
 * `OtpCode.phone` is stored as NORMALIZED digits (via `phoneDigits`), not the
 * raw submitted string — so a code requested as "+971 50 123 4567" can be
 * verified as "0501234567", exactly like user-matching already treats phone
 * numbers. Keying on the raw string only worked by coincidence (the client
 * happening to send an identical string both times).
 */
export async function createOtpCode(
  phone: string,
  purpose: OtpPurpose,
): Promise<{ id: string; plainCode: string; expiresAt: Date }> {
  const normalizedPhone = phoneDigits(phone);
  await prisma.otpCode.updateMany({
    where: { phone: normalizedPhone, purpose, consumedAt: null },
    data: { consumedAt: new Date() }, // invalidate — not a real "use," just supersession
  });
  const plainCode = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const created = await prisma.otpCode.create({
    data: { phone: normalizedPhone, purpose, codeHash: hashOtp(plainCode), expiresAt },
  });
  return { id: created.id, plainCode, expiresAt };
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
    where: { phone: phoneDigits(phone), purpose, consumedAt: null },
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
export async function issueSession(
  userId: string,
  client: Pick<typeof prisma, 'session'> = prisma,
): Promise<{ plainToken: string; expiresAt: Date }> {
  const plainToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await client.session.create({
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
