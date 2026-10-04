/**
 * Moves existing phone numbers to E.164 (#54). See server/src/lib/phoneBackfill.ts
 * for the safety rules.
 *
 * Runs on every API start, before the server (package.json `server:start`).
 * It's idempotent: once everything is converted it only logs the summary.
 * It NEVER blocks a start: on any error it logs and exits 0, so a backfill
 * problem can't take the API down. The worst case is that some numbers stay
 * in their old format, which the summary line shows.
 *
 *   npm run phones:backfill -- --dry-run   (local, this branch's schema: show the plan, write nothing)
 */
import { PrismaClient } from '@prisma/client';
import { backfillPhonesToE164, describePhoneBackfill } from '../src/lib/phoneBackfill.js';

const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient();
try {
  const report = await backfillPhonesToE164(prisma, { dryRun });
  console.log(describePhoneBackfill(report, dryRun));
} catch (err) {
  console.error('[phone-e164] backfill FAILED, nothing written (one transaction); the API starts anyway:', err);
} finally {
  await prisma.$disconnect();
}
