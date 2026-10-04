import { prisma } from '../prisma.js';
import { revokeUserAccess } from '../identity.js';
import { writeAuditLog } from '../auditLog.js';
import { assertNotLastActiveOwner, LastOwnerError } from './employmentStatusActions.js';

/** The name a deleted account shows wherever its past shifts or attendance still appear. */
export const DELETED_USER_NAME = 'Deleted user';

export class AccountAlreadyDeletedError extends Error {
  constructor() {
    super('This account has already been deleted.');
    this.name = 'AccountAlreadyDeletedError';
  }
}

/** Raised instead of LastOwnerError so the person deleting their own account gets advice, not a staff-directory message. */
export class LastOwnerDeletionError extends Error {
  constructor() {
    super(
      "You're the only owner of this venue, so your account can't be deleted yet. Make another manager an owner first, or contact ShiftSync support to close the venue.",
    );
    this.name = 'LastOwnerDeletionError';
  }
}

/**
 * Self-service account deletion (App Store 5.1.1(v) / Google Play account-deletion policy).
 * Immediate and irreversible, in one transaction:
 *  - an OWNER who is the venue's last active owner is refused (the venue would be ownerless);
 *  - every session and unspent login link ends (revokeUserAccess);
 *  - push subscriptions, notifications, voice transcripts and sign-in codes are deleted;
 *  - name, phone, email, job title, language and ID numbers are cleared on the user row, which
 *    stays — de-identified, inactive, `deletedAt` set — so past shifts, attendance and swaps keep
 *    their history without saying who it was;
 *  - the person's own join-request records are de-identified the same way;
 *  - one ACCOUNT_DELETED audit row (no personal details in it).
 */
export async function deleteOwnAccount(userId: string, now: Date = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, locationId: true, systemRole: true, isActive: true, phone: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw new AccountAlreadyDeletedError();
    if (user.systemRole === 'OWNER' && user.isActive) {
      try {
        await assertNotLastActiveOwner(tx, user.locationId, user.id);
      } catch (err) {
        if (err instanceof LastOwnerError) throw new LastOwnerDeletionError();
        throw err;
      }
    }

    await revokeUserAccess(tx, user, user.id);
    await tx.pushSubscription.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.voiceInteractionLog.deleteMany({ where: { actorId: userId } });
    if (user.phone) {
      await tx.otpCode.deleteMany({ where: { phone: user.phone } });
      await tx.joinRequest.updateMany({ where: { phone: user.phone }, data: { phone: '', fullName: DELETED_USER_NAME } });
    }
    await tx.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        deletedAt: now,
        terminatedAt: now,
        fullName: DELETED_USER_NAME,
        phone: null,
        phoneBeforeE164: null,
        email: null,
        jobTitle: null,
        preferredLanguage: null,
        emiratesIdNumber: null,
        laborCardNumber: null,
      },
    });
    await writeAuditLog(tx, {
      locationId: user.locationId,
      actorId: user.id,
      action: 'ACCOUNT_DELETED',
      entityType: 'User',
      entityId: user.id,
      note: 'Account deleted by its owner in the app; personal details removed.',
    });
  });
}
