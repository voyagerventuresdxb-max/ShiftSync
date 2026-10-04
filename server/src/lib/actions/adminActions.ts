import { prisma } from '../prisma.js';
import { toE164, INVALID_PHONE_ERROR } from '../phone.js';
import { findUserByPhone } from '../../routes/identity.js';
import { writeAuditLog } from '../auditLog.js';
import { DEFAULT_ROLES } from '../../../../shared/defaultRoles.js';
import { mintLoginLinkForCli } from './loginLinkActions.js';

/**
 * Operator actions. Both are reachable ONLY from the CLI scripts under
 * server/scripts/ — there is deliberately no route for either, so a
 * compromised session can never grant itself platform admin or spin up
 * venues. Kept as plain functions so they can be tested without spawning a
 * process.
 */

function requireE164(phone: string): string {
  const e164 = toE164(phone);
  if (!e164) throw new Error(`${phone}: ${INVALID_PHONE_ERROR}`);
  return e164;
}

/** `npm run admin:grant -- <phone>` — flags the active user with that phone (any format `toE164` accepts) as platform admin. */
export async function grantPlatformAdmin(phone: string): Promise<{ id: string; fullName: string; phone: string | null }> {
  const match = await findUserByPhone(requireE164(phone));
  if (!match || !match.isActive) throw new Error(`No active user has the phone number ${phone}.`);
  return prisma.user.update({
    where: { id: match.id },
    data: { isPlatformAdmin: true },
    select: { id: true, fullName: true, phone: true },
  });
}

export interface OrgShellInput {
  venueName: string;
  ownerFullName: string;
  ownerPhone: string;
}

/**
 * `npm run org:create -- --venue "…" --owner "…" --phone +971…` — an
 * operator-made venue: Organization + Location + the OWNER user + the
 * default roles (the same shape routes/signup.ts creates), then the owner's
 * first login link. Their tap lands them in the wizard at Venue (see
 * landingFor in loginLinkActions.ts).
 */
export async function createOrgShell(input: OrgShellInput) {
  const venueName = input.venueName.trim();
  const ownerFullName = input.ownerFullName.trim();
  const rawPhone = input.ownerPhone.trim();
  if (!venueName) throw new Error('venueName is required.');
  if (!ownerFullName) throw new Error('ownerFullName is required.');
  if (!rawPhone) throw new Error('ownerPhone is required.');
  const ownerPhone = requireE164(rawPhone);

  // User.phone is unique across deactivated users too, so any holder blocks the create.
  if (await findUserByPhone(ownerPhone)) throw new Error(`A user already has the phone number ${ownerPhone}.`);

  const { organization, location, owner } = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({ data: { name: venueName } });
    const location = await tx.location.create({ data: { organizationId: organization.id, name: venueName } });
    const owner = await tx.user.create({
      data: { locationId: location.id, fullName: ownerFullName, phone: ownerPhone, systemRole: 'OWNER' },
    });
    await tx.role.createMany({ data: DEFAULT_ROLES.map((name) => ({ locationId: location.id, name })) });
    await writeAuditLog(tx, {
      locationId: location.id,
      actorId: owner.id,
      action: 'STAFF_CREATED',
      entityType: 'Location',
      entityId: location.id,
      note: `[org-shell CLI] Venue "${venueName}" created by the operator; owner: ${ownerFullName}.`,
    });
    return { organization, location, owner };
  });

  const issued = await mintLoginLinkForCli(owner.id);
  if (issued.result !== 'ok') throw new Error('Owner created but the login link could not be issued.');
  return { organization, location, owner, link: issued.link };
}
