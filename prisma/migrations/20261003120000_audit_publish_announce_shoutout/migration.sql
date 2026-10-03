-- AlterEnum (additive): audit rows for rota publish, announcements and shoutouts.
-- One value per statement so the migration also applies on PostgreSQL <= 11.
ALTER TYPE "AuditAction" ADD VALUE 'ROTA_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'ANNOUNCEMENT_POSTED';
ALTER TYPE "AuditAction" ADD VALUE 'SHOUTOUT_POSTED';
