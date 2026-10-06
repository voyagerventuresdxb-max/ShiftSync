import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { hashOtp } from './identity.js';
import { resolveInviteBaseUrl } from './inviteLinks.js';
import { KIOSK_PATH } from '../../../shared/kioskLinks.js';

/**
 * Per-venue kiosk links: a shared screen at the venue opens one to show this
 * week's published rota, announcements and shoutouts without a personal
 * sign-in (middleware/kioskAccess.ts). The token is 256 random bits,
 * base64url; only its sha256 is stored on the venue, so at most one kiosk link
 * per venue works at a time and the token itself is shown once, when created.
 * Regenerate/revoke are not written to the AuditLog: no AuditAction value
 * covers kiosk links.
 */

const KIOSK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The link a manager puts on the shared screen. Its origin is allowlisted exactly like invite links'. */
export function buildKioskUrl(locationId: string, token: string, requestedBaseUrl: unknown): string {
  return `${resolveInviteBaseUrl(requestedBaseUrl)}${KIOSK_PATH}?venue=${encodeURIComponent(locationId)}#k=${token}`;
}

/** Replaces the venue's kiosk token in one write, so the previous one stops working with it. Returns the new token. */
export async function regenerateKioskToken(locationId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<{ token: string; createdAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const createdAt = new Date();
  await client.location.update({ where: { id: locationId }, data: { kioskTokenHash: hashOtp(token), kioskTokenCreatedAt: createdAt } });
  return { token, createdAt };
}

/** After this, no kiosk token works for the venue. */
export async function revokeKioskToken(locationId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<void> {
  await client.location.update({ where: { id: locationId }, data: { kioskTokenHash: null, kioskTokenCreatedAt: null } });
}

/** True only for the venue's current kiosk token. */
export async function isCurrentKioskToken(locationId: string, token: string): Promise<boolean> {
  if (!KIOSK_TOKEN_SHAPE.test(token)) return false;
  const venue = await prisma.location.findUnique({ where: { kioskTokenHash: hashOtp(token) }, select: { id: true } });
  return venue?.id === locationId;
}
