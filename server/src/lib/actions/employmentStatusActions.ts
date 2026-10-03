import type { Prisma, SystemRole } from '@prisma/client';

/**
 * Who may change whose employment status (the Staff Directory's
 * Active/Inactive toggle). Decided 2026-10-03:
 *
 *  - a MANAGER may deactivate or reactivate STAFF only;
 *  - an OWNER may deactivate or reactivate MANAGERs and STAFF;
 *  - nobody changes their own status;
 *  - the last remaining active OWNER of a venue can never be deactivated
 *    (`assertNotLastActiveOwner`, enforced inside the write transaction).
 *
 * STAFF never reach this: the route is behind `requireManager`. These rules
 * are pure so they can be unit-tested without a database; the route turns a
 * non-null result into a 403.
 */
export interface StatusActor {
  id: string;
  systemRole: SystemRole;
}
export interface StatusTarget {
  id: string;
  systemRole: SystemRole;
}

export function employmentStatusRefusal(actor: StatusActor, target: StatusTarget): string | null {
  if (actor.id === target.id) return "You can't change your own employment status. Ask another manager or the owner.";
  if (actor.systemRole === 'MANAGER' && target.systemRole !== 'STAFF') {
    return 'Managers can change the status of staff only. Ask the owner to change a manager or owner.';
  }
  if (actor.systemRole === 'OWNER' && target.systemRole === 'OWNER') {
    return "An owner's status can't be changed from the Staff Directory.";
  }
  if (actor.systemRole !== 'OWNER' && actor.systemRole !== 'MANAGER') {
    return 'This action requires a manager or owner account.';
  }
  return null;
}

/** Thrown by `assertNotLastActiveOwner`; the route answers 409. */
export class LastOwnerError extends Error {
  constructor() {
    super("This is the venue's last active owner and can't be deactivated.");
    this.name = 'LastOwnerError';
  }
}

/**
 * Invariant, independent of who is asking: a venue always keeps at least one
 * active OWNER. Call inside the transaction that deactivates `userId` when
 * `userId` is an OWNER. The per-venue advisory lock serialises concurrent
 * deactivations at the same venue, so two requests can't each see "another
 * owner is still active" and together deactivate both.
 */
export async function assertNotLastActiveOwner(tx: Prisma.TransactionClient, locationId: string, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`owners:${locationId}`}))::text`;
  const otherActiveOwners = await tx.user.count({
    where: { locationId, systemRole: 'OWNER', isActive: true, id: { not: userId } },
  });
  if (otherActiveOwners === 0) throw new LastOwnerError();
}
