-- Additive: in-app account deletion.
-- AlterEnum: one audit action for "a person deleted their own account".
ALTER TYPE "AuditAction" ADD VALUE 'ACCOUNT_DELETED';

-- AlterTable: when a user deleted their own account (their personal details are cleared; the row stays de-identified).
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);
