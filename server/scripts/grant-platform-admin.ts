/**
 * Grants platform-admin to the one active user with the given phone number.
 * This is the ONLY way the flag is ever set — there is no API route for it.
 *
 * Usage (locally, against this branch's schema):
 *   npm run admin:grant -- +971501234567
 * On the server: tsx server/scripts/grant-platform-admin.ts +971501234567
 */
import 'dotenv/config';
import { grantPlatformAdmin } from '../src/lib/actions/adminActions.js';
import { prisma } from '../src/lib/prisma.js';

const phone = process.argv[2]?.trim();
if (!phone) {
  console.error('Usage: npm run admin:grant -- <phone>');
  process.exit(2);
}

try {
  const user = await grantPlatformAdmin(phone);
  console.log(`Platform admin granted to ${user.fullName} (${user.phone}) — user id ${user.id}.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
