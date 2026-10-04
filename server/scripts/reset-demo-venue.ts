/**
 * Returns the demo venue to its starting state between demo runs:
 *
 *   npm run db:reset:demo -- --phones=<owner>,<staff>,<applicant>
 *
 * Deletes the demo organization (everything under it goes with it: the venue,
 * people who joined during the demo, shifts, announcements, floor-plan
 * assignments, notifications, sessions) and the three numbers' sign-in codes,
 * then runs `seed-demo-venue.ts` with the same numbers, so the venue is exactly
 * what a fresh seed gives. Takes a few seconds.
 *
 * LOCAL ONLY, like the seed: it refuses to run unless DATABASE_URL's host is
 * localhost / 127.0.0.1, and it has no override flag.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDatabaseHost } from '../src/lib/testVenueCleanup.js';
import { toE164 } from '../src/lib/phone.js';

const ORG_ID = 'demo-org';

function usage(message: string): never {
  console.error(`\n[reset-demo-venue] ${message}\n\nUsage: npm run db:reset:demo -- --phones=<owner>,<staff>,<applicant>\n  the same three numbers you seeded the demo venue with.\n`);
  process.exit(1);
}

const hostCheck = checkDatabaseHost(process.env.DATABASE_URL);
if (!hostCheck.ok) usage(hostCheck.reason);
if (hostCheck.production) usage('This script never runs against production.');

const phonesArg = process.argv.find((a) => a.startsWith('--phones='))?.slice('--phones='.length) ?? '';
const phones = phonesArg.split(',').map((p) => toE164(p.trim()));
if (phones.length !== 3 || phones.some((p) => !p)) usage('--phones needs exactly three valid mobile numbers, comma-separated.');

// Import after the host check: constructing the client is what connects.
const { prisma } = await import('../src/lib/prisma.js');

const started = Date.now();
try {
  await prisma.otpCode.deleteMany({ where: { phone: { in: phones as string[] } } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
} catch (err) {
  console.error('[reset-demo-venue] could not clear the demo venue', err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

// Same process environment (DATABASE_URL already points at this branch's schema), same numbers.
const seed = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./seed-demo-venue.ts', import.meta.url)), `--phones=${phonesArg}`], {
  stdio: 'inherit',
  env: process.env,
});
if (seed.status !== 0) {
  console.error('[reset-demo-venue] the seed failed; the demo venue is empty until it succeeds.');
  process.exit(seed.status ?? 1);
}
console.log(`[reset-demo-venue] demo venue reset in ${((Date.now() - started) / 1000).toFixed(1)}s`);
