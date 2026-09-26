import type { User } from '@prisma/client';
import { prisma } from '../prisma.js';
import { hashOtp, issueSession } from '../identity.js';
import { writeAuditLog } from '../auditLog.js';
import { buildLoginLinkUrl, generateLoginLinkToken, loginLinkExpiry, loginLinkShareText } from '../loginLinks.js';

/**
 * One-time login links — the whole lifecycle in one place so the REST
 * route, the CLI and the tests all go through the same checks.
 *
 * Every scope failure below resolves to `not_found`, and the route turns
 * that into a 404: a 403 would confirm to a caller probing ids that the
 * user exists and merely isn't theirs (the same reasoning as
 * `ownedOrNotFound` in middleware/requireSession.ts; `assertOwnsLocation`
 * is not used here precisely because it answers 403).
 */

export type Issuer = Pick<User, 'id' | 'locationId' | 'systemRole' | 'isPlatformAdmin'>;

type TargetWithLocation = User & { location: { id: string; name: string; organizationId: string; emirate: string | null; venueType: string | null } };

export type IssueResult =
  | { result: 'not_found' }
  | { result: 'ok'; link: { id: string; url: string; expiresAt: Date; shareText: string; targetUserId: string } };

/**
 * Who may issue to whom (all three conditions are OR'd, so a platform admin
 * who also owns a venue keeps their owner powers):
 *  - platform admin → OWNER or MANAGER, any venue;
 *  - OWNER          → MANAGER or STAFF at any location of the owner's own organization;
 *  - MANAGER        → STAFF at the manager's own location.
 * Never yourself, never an inactive user. Anything else: null.
 */
export async function findIssuableTarget(issuer: Issuer, targetUserId: string): Promise<TargetWithLocation | null> {
  if (!targetUserId || targetUserId === issuer.id) return null;
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { location: { select: { id: true, name: true, organizationId: true, emirate: true, venueType: true } } },
  });
  if (!target || !target.isActive) return null;

  if (issuer.isPlatformAdmin && (target.systemRole === 'OWNER' || target.systemRole === 'MANAGER')) return target;

  if (issuer.systemRole === 'OWNER' && (target.systemRole === 'MANAGER' || target.systemRole === 'STAFF')) {
    const issuerLocation = await prisma.location.findUnique({ where: { id: issuer.locationId }, select: { organizationId: true } });
    if (issuerLocation && issuerLocation.organizationId === target.location.organizationId) return target;
  }

  if (issuer.systemRole === 'MANAGER' && target.systemRole === 'STAFF' && target.locationId === issuer.locationId) return target;

  return null;
}

/**
 * Mints a link for `target`. Any older unconsumed link for the same person
 * is revoked first (so at most one live link exists per user, and a
 * forwarded stale link is dead the moment a new one goes out), then the new
 * row and both audit entries are written in one transaction.
 */
async function mintLink(target: TargetWithLocation, issuedById: string | null): Promise<IssueResult> {
  const token = generateLoginLinkToken();
  const now = new Date();
  const expiresAt = loginLinkExpiry(now);
  const link = await prisma.$transaction(async (tx) => {
    const superseded = await tx.loginLink.updateMany({
      where: { userId: target.id, consumedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    if (superseded.count > 0) {
      await writeAuditLog(tx, {
        locationId: target.locationId,
        actorId: issuedById,
        action: 'LOGIN_LINK_REVOKED',
        entityType: 'User',
        entityId: target.id,
        note: `${superseded.count} earlier login link(s) superseded by a new one.`,
      });
    }
    const created = await tx.loginLink.create({
      data: { tokenHash: hashOtp(token), userId: target.id, issuedById, locationId: target.locationId, expiresAt },
    });
    await writeAuditLog(tx, {
      locationId: target.locationId,
      actorId: issuedById,
      action: 'LOGIN_LINK_ISSUED',
      entityType: 'LoginLink',
      entityId: created.id,
      note: `Login link issued for ${target.fullName} (${target.systemRole}); expires ${expiresAt.toISOString()}.`,
    });
    return created;
  });
  return {
    result: 'ok',
    link: { id: link.id, url: buildLoginLinkUrl(token), expiresAt, shareText: loginLinkShareText(target.location.name), targetUserId: target.id },
  };
}

/** REST path: scope-checked against the signed-in issuer. */
export async function issueLoginLink(issuer: Issuer, targetUserId: string): Promise<IssueResult> {
  const target = await findIssuableTarget(issuer, targetUserId);
  if (!target) return { result: 'not_found' };
  return mintLink(target, issuer.id);
}

/**
 * CLI path (server/scripts/create-org-shell.ts): no issuer, no scope — the
 * operator running the script on the server IS the authority. Never
 * reachable from a route.
 */
export async function mintLoginLinkForCli(userId: string): Promise<IssueResult> {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    include: { location: { select: { id: true, name: true, organizationId: true, emirate: true, venueType: true } } },
  });
  if (!target || !target.isActive) return { result: 'not_found' };
  return mintLink(target, null);
}

export type LinkRejection = 'unknown' | 'used' | 'expired' | 'revoked' | 'inactive';

export type PeekResult =
  | { result: 'ok'; fullName: string; venueName: string; expiresAt: Date }
  | { result: 'rejected'; reason: LinkRejection };

function rejectionFor(link: { consumedAt: Date | null; revokedAt: Date | null; expiresAt: Date; user: { isActive: boolean } }, now: Date): LinkRejection | null {
  if (link.consumedAt) return 'used';
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt <= now) return 'expired';
  if (!link.user.isActive) return 'inactive';
  return null;
}

/**
 * What the page shows BEFORE the person taps Sign in. Read-only by design —
 * a link scanner, a chat app's preview fetch or a curious tap on the page
 * must never spend the link; only `redeemLoginLink` does.
 */
export async function peekLoginLink(token: string): Promise<PeekResult> {
  const link = await prisma.loginLink.findUnique({
    where: { tokenHash: hashOtp(token) },
    include: { user: { select: { fullName: true, isActive: true, location: { select: { name: true } } } } },
  });
  if (!link) return { result: 'rejected', reason: 'unknown' };
  const reason = rejectionFor(link, new Date());
  if (reason) return { result: 'rejected', reason };
  return { result: 'ok', fullName: link.user.fullName, venueName: link.user.location.name, expiresAt: link.expiresAt };
}

export type RedeemResult =
  | { result: 'rejected'; reason: LinkRejection }
  | {
      result: 'ok';
      token: string;
      expiresAt: Date;
      user: { id: string; fullName: string; jobTitle: string | null; locationId: string; systemRole: User['systemRole'] };
      landing: string;
    };

/** Where to send someone right after their link signs them in. */
export function landingFor(user: Pick<User, 'systemRole'>, location: { emirate: string | null; venueType: string | null }): string {
  // An owner whose venue was created as a bare shell (CLI) and never set
  // up: straight into the wizard at Venue — Account is skipped because
  // they already have one.
  if (user.systemRole === 'OWNER' && !location.emirate && !location.venueType) return '/onboarding/venue';
  return '/my-shifts';
}

/**
 * Spends the link and issues a session. The claim is ONE conditional
 * `updateMany` — unconsumed, unrevoked, unexpired, active user — so two
 * concurrent redeems race on the database row and exactly one sees
 * `count === 1`; the other is told the link was used.
 */
export async function redeemLoginLink(token: string, meta: { ip: string | null; userAgent: string | null }): Promise<RedeemResult> {
  const tokenHash = hashOtp(token);
  const now = new Date();
  const claimed = await prisma.loginLink.updateMany({
    where: { tokenHash, consumedAt: null, revokedAt: null, expiresAt: { gt: now }, user: { is: { isActive: true } } },
    data: { consumedAt: now, redeemedIp: meta.ip, redeemedUserAgent: meta.userAgent?.slice(0, 512) ?? null },
  });

  if (claimed.count !== 1) {
    const link = await prisma.loginLink.findUnique({ where: { tokenHash }, include: { user: { select: { isActive: true } } } });
    if (!link) return { result: 'rejected', reason: 'unknown' };
    const reason = rejectionFor(link, now) ?? 'used';
    await writeAuditLog(prisma, {
      locationId: link.locationId,
      actorId: null,
      action: 'LOGIN_LINK_REJECTED',
      entityType: 'LoginLink',
      entityId: link.id,
      note: `Redeem refused (${reason}) from ${meta.ip ?? 'unknown ip'}.`,
    });
    return { result: 'rejected', reason };
  }

  const link = await prisma.loginLink.findUniqueOrThrow({
    where: { tokenHash },
    include: { user: { include: { location: { select: { emirate: true, venueType: true } } } } },
  });
  const { plainToken, expiresAt } = await issueSession(link.userId);
  await writeAuditLog(prisma, {
    locationId: link.locationId,
    actorId: link.userId,
    action: 'LOGIN_LINK_REDEEMED',
    entityType: 'LoginLink',
    entityId: link.id,
    note: `Signed in via login link from ${meta.ip ?? 'unknown ip'}.`,
  });
  const u = link.user;
  return {
    result: 'ok',
    token: plainToken,
    expiresAt,
    user: { id: u.id, fullName: u.fullName, jobTitle: u.jobTitle, locationId: u.locationId, systemRole: u.systemRole },
    landing: landingFor(u, u.location),
  };
}

/**
 * Revokes one link. Allowed for whoever issued it, and for anyone who could
 * issue a link to that person today (a manager can kill a link their
 * colleague sent to their own staff member). Otherwise 404-shaped.
 */
export async function revokeLoginLink(caller: Issuer, linkId: string): Promise<'ok' | 'not_found'> {
  const link = await prisma.loginLink.findUnique({ where: { id: linkId } });
  if (!link) return 'not_found';
  const mayRevoke = link.issuedById === caller.id || (await findIssuableTarget(caller, link.userId)) !== null;
  if (!mayRevoke) return 'not_found';
  if (!link.revokedAt && !link.consumedAt) {
    await prisma.$transaction(async (tx) => {
      await tx.loginLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
      await writeAuditLog(tx, {
        locationId: link.locationId,
        actorId: caller.id,
        action: 'LOGIN_LINK_REVOKED',
        entityType: 'LoginLink',
        entityId: link.id,
        note: 'Login link revoked.',
      });
    });
  }
  return 'ok';
}
