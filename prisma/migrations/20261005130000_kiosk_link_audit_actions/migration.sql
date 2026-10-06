-- Additive: audit actions for kiosk links (create, regenerate, revoke).
-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'KIOSK_LINK_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'KIOSK_LINK_REGENERATED';
ALTER TYPE "AuditAction" ADD VALUE 'KIOSK_LINK_REVOKED';
