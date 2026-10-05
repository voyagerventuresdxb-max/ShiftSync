import { randomBytes } from 'node:crypto';
import type { InviteLink, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { generateQrDataUrl } from './qrCode.js';
import { writeAuditLog } from './auditLog.js';

export const DEFAULT_INVITE_EXPIRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:5173';

/**
 * Origins the server will ever mint an invite link against. `FRONTEND_ORIGIN`
 * (comma-separated for multiple environments, e.g. staging + prod) configures
 * the allowlist; unset, only the local dev origin is allowed. Read fresh on
 * every call (not memoized at module load) so it can be reconfigured — e.g.
 * per-test — without restarting the process.
 */
export function getAllowedFrontendOrigins(): string[] {
  const configured = process.env.FRONTEND_ORIGIN?.trim();
  if (!configured) return [DEFAULT_FRONTEND_ORIGIN];
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * The client-supplied `baseUrl` is only ever used as a display convenience
 * (so invite links point at the app the manager is actually using, not this
 * API's own host — the 2026-09-15 fix). It must never be trusted
 * verbatim: a compromised or forged client could otherwise mint a QR/WhatsApp
 * invite pointing at an attacker-controlled domain. Only an origin present in
 * the server-side allowlist is honored; anything else (including no value at
 * all) falls back to the first configured/default origin.
 */
export function resolveInviteBaseUrl(requestedBaseUrl: unknown): string {
  const allowed = getAllowedFrontendOrigins();
  const requested = typeof requestedBaseUrl === 'string' ? requestedBaseUrl.replace(/\/+$/, '') : undefined;
  return requested && allowed.includes(requested) ? requested : allowed[0];
}

/** 32 random bytes, base64url: 43 URL-safe characters. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export const INVITE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type InviteRejection = 'expired' | 'revoked' | 'used_up' | 'not_found' | 'legacy_expired';

export const INVITE_REJECTION_MESSAGES: Record<InviteRejection, string> = {
  expired: 'This invite link has expired — ask your manager for a new one.',
  revoked: 'This invite link is no longer active — ask your manager for a new one.',
  used_up: 'This invite link has already been used the maximum number of times — ask your manager for a new one.',
  not_found: "This invite link isn't valid — check you have the whole link, or ask your manager for a new one.",
  legacy_expired: 'This invite link has expired — ask your manager for a new one.',
};

type LinkState = Pick<InviteLink, 'revokedAt' | 'expiresAt' | 'maxUses' | 'useCount'>;

/** Why a link can't be used now, or null if it can. */
export function inviteLinkRejection(link: LinkState | null, now = new Date()): InviteRejection | null {
  if (!link) return 'not_found';
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt <= now) return 'expired';
  if (link.maxUses !== null && link.useCount >= link.maxUses) return 'used_up';
  return null;
}

export function isLegacyJoinLinkAccepted(location: { legacyJoinLinksUntil: Date | null }, now = new Date()): boolean {
  return location.legacyJoinLinksUntil !== null && location.legacyJoinLinksUntil > now;
}

type Client = Prisma.TransactionClient | typeof prisma;

/** The venue's newest usable link, or null. */
export async function findActiveInviteLink(client: Client, locationId: string, now = new Date()): Promise<InviteLink | null> {
  const live = await client.inviteLink.findMany({
    where: { locationId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  });
  return live.find((link) => inviteLinkRejection(link, now) === null) ?? null;
}

/** The re-read reason a link just failed `consumeInviteUse`. */
export async function currentInviteRejection(linkId: string): Promise<InviteRejection> {
  const link = await prisma.inviteLink.findUnique({ where: { id: linkId } });
  return inviteLinkRejection(link) ?? 'used_up';
}

/**
 * Counts one use, atomically: a single conditional UPDATE, so concurrent joins
 * on a link with one use left can't both pass. False = the link is no longer usable.
 */
export async function consumeInviteUse(client: Client, linkId: string): Promise<boolean> {
  const updated = await client.$executeRaw`
    UPDATE invite_links SET use_count = use_count + 1
    WHERE id = ${linkId} AND revoked_at IS NULL AND expires_at > (now() AT TIME ZONE 'UTC')
      AND (max_uses IS NULL OR use_count < max_uses)`;
  return updated === 1;
}

/** Serializes invite-link writes per venue, so it never has two unrevoked links. */
async function lockVenueInvites(tx: Prisma.TransactionClient, locationId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`invite:${locationId}`}))::text`;
}

async function revokeOpenLinks(tx: Prisma.TransactionClient, locationId: string, actorId: string | null, now: Date, note: string): Promise<number> {
  const open = await tx.inviteLink.findMany({ where: { locationId, revokedAt: null }, select: { id: true } });
  for (const { id } of open) {
    await tx.inviteLink.update({ where: { id }, data: { revokedAt: now } });
    await writeAuditLog(tx, { locationId, actorId, action: 'INVITE_LINK_REVOKED', entityType: 'InviteLink', entityId: id, note });
  }
  return open.length;
}

export interface InviteLinkOptions {
  expiresInDays: number;
  maxUses: number | null;
}

async function createLink(tx: Prisma.TransactionClient, locationId: string, actorId: string | null, opts: InviteLinkOptions, now: Date): Promise<InviteLink> {
  const link = await tx.inviteLink.create({
    data: { locationId, token: generateInviteToken(), createdById: actorId, expiresAt: new Date(now.getTime() + opts.expiresInDays * DAY_MS), maxUses: opts.maxUses },
  });
  await writeAuditLog(tx, {
    locationId,
    actorId,
    action: 'INVITE_LINK_CREATED',
    entityType: 'InviteLink',
    entityId: link.id,
    note: `Expires ${link.expiresAt.toISOString()}; ${opts.maxUses === null ? 'unlimited uses' : `up to ${opts.maxUses} uses`}.`,
  });
  return link;
}

/** Revokes the venue's current link(s) and creates a new one, in one transaction. */
export async function regenerateInviteLink(locationId: string, actorId: string | null, opts: InviteLinkOptions): Promise<InviteLink> {
  return prisma.$transaction(async (tx) => {
    await lockVenueInvites(tx, locationId);
    const now = new Date();
    await revokeOpenLinks(tx, locationId, actorId, now, 'Replaced by a new link.');
    return createLink(tx, locationId, actorId, opts, now);
  });
}

/** Revokes every unrevoked link for the venue; returns how many. */
export async function revokeInviteLinks(locationId: string, actorId: string | null): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await lockVenueInvites(tx, locationId);
    return revokeOpenLinks(tx, locationId, actorId, new Date(), 'Revoked by a manager.');
  });
}

/** The venue's active link, creating one (default expiry, unlimited uses) only if there is none. */
export async function ensureActiveInviteLink(locationId: string, actorId: string | null): Promise<InviteLink> {
  return prisma.$transaction(async (tx) => {
    await lockVenueInvites(tx, locationId);
    const now = new Date();
    const active = await findActiveInviteLink(tx, locationId, now);
    if (active) return active;
    await revokeOpenLinks(tx, locationId, actorId, now, 'Replaced by a new link (it had expired or was used up).');
    return createLink(tx, locationId, actorId, { expiresInDays: DEFAULT_INVITE_EXPIRY_DAYS, maxUses: null }, now);
  });
}

/** Validates a regenerate body: expiresInDays 1–90 (default 30), maxUses null or 1–1000. */
export function parseInviteLinkOptions(body: unknown): InviteLinkOptions | { error: string } {
  const input = (body ?? {}) as { expiresInDays?: unknown; maxUses?: unknown };
  const expiresInDays = input.expiresInDays ?? DEFAULT_INVITE_EXPIRY_DAYS;
  if (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    return { error: 'expiresInDays must be a whole number from 1 to 90.' };
  }
  const maxUses = input.maxUses ?? null;
  if (maxUses !== null && (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) {
    return { error: 'maxUses must be empty or a whole number from 1 to 1000.' };
  }
  return { expiresInDays, maxUses };
}

/** What the manager UI shows for a link: the URL, its QR and WhatsApp share, and its limits. */
export async function presentInviteLink(link: InviteLink, venueName: string, requestedBaseUrl: unknown) {
  const inviteUrl = `${resolveInviteBaseUrl(requestedBaseUrl)}/join?invite=${link.token}`;
  return {
    inviteUrl,
    qrDataUrl: await generateQrDataUrl(inviteUrl),
    whatsappUrl: `https://wa.me/?text=${encodeURIComponent(`You've been added to ${venueName}'s team on ShiftSync. Join here: ${inviteUrl}`)}`,
    expiresAt: link.expiresAt.toISOString(),
    maxUses: link.maxUses,
    useCount: link.useCount,
    createdAt: link.createdAt.toISOString(),
  };
}
