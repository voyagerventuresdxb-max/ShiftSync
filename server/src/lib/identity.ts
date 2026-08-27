import { randomInt, randomBytes, createHash } from 'node:crypto';
import { prisma } from './prisma.js';
import type { OtpPurpose, User } from '@prisma/client';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — long-lived, no refresh flow in this lightweight model
const MAX_OTP_ATTEMPTS = 5;

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
 */
export async function createOtpCode(
  phone: string,
  purpose: OtpPurpose,
): Promise<{ id: string; plainCode: string; expiresAt: Date }> {
  await prisma.otpCode.updateMany({
    where: { phone, purpose, consumedAt: null },
    data: { consumedAt: new Date() }, // invalidate — not a real "use," just supersession
  });
  const plainCode = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const created = await prisma.otpCode.create({
    data: { phone, purpose, codeHash: hashOtp(plainCode), expiresAt },
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
  const record = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumedAt: null },
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

/** Resolves a bearer token to its real User, or null if missing/expired/unknown. */
export async function resolveSession(plainToken: string): Promise<User | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashOtp(plainToken) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}
