/**
 * Finds and deletes test venues (orgs named with a test prefix: e2e runs, server
 * tests, deploy checks) and their uploaded files (#53). Dry run unless --confirm.
 * Refuses, before any query, to run against a non-local DATABASE_URL unless
 * --i-am-running-against-production=<that exact host> is given.
 * Rules and the production procedure: docs/test-venue-cleanup.md. Logic: server/src/lib/testVenueCleanup.ts.
 *
 *   npm run cleanup:test-venues                 (local, this branch's schema: dry run)
 *   npm run cleanup:test-venues -- --confirm    (local: delete)
 */
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  USAGE,
  buildCleanupPlan,
  checkDatabaseHost,
  executeCleanupPlan,
  formatPlan,
  formatResults,
  parseCliArgs,
  type CliOptions,
} from '../src/lib/testVenueCleanup.js';

// server/uploads locally; /app/server/uploads on Railway (the uploads volume).
const UPLOADS_DIR = join(import.meta.dirname, '..', 'uploads');

let options: CliOptions;
try {
  options = parseCliArgs(process.argv.slice(2));
} catch (err) {
  console.error(`REFUSED: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
const hostCheck = checkDatabaseHost(databaseUrl, options.productionHost);
if (!hostCheck.ok) {
  console.error(`REFUSED: ${hostCheck.reason}`);
  process.exit(2);
}
if (hostCheck.production) console.log(`*** PRODUCTION: ${hostCheck.host} (--i-am-running-against-production) ***\n`);

// Built only after the host check, and from the exact URL that was checked.
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
try {
  const plan = await buildCleanupPlan(prisma, { uploadsDir: UPLOADS_DIR, name: options.name });
  console.log(formatPlan(plan, hostCheck.host, options.confirm));
  if (options.confirm && plan.orgs.length) {
    const results = await executeCleanupPlan(prisma, plan);
    console.log(formatResults(results));
    if (results.some((r) => !r.deleted || r.files.some((f) => f.outcome.startsWith('NOT')))) process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
