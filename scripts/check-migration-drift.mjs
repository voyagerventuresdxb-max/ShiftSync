#!/usr/bin/env node
/**
 * Does prisma/migrations produce exactly prisma/schema.prisma?
 *
 *   npm run prisma:check-drift
 *
 * Exit 0 = no drift, 2 = drift (the SQL diff is printed), 1 = error.
 *
 * `prisma migrate diff --from-migrations` needs a SHADOW database, and
 * Prisma RESETS the shadow (drops everything in it) before replaying the
 * migrations. So the shadow must never be a schema anyone uses. This script
 * points it at a throwaway `shadow_<branch>` schema in the same local
 * database, then drops that schema whatever happens.
 *
 * Exists because the obvious one-liner through with-branch-schema
 * (`--shadow-database-url "$DATABASE_URL"`) wiped a branch's live dev schema
 * (2026-09-30). The wrapper now refuses that — see destructiveCommandReason
 * in scripts/with-branch-schema.mjs.
 */
import { spawnSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { schemaNameFor, withSchema } from './with-branch-schema.mjs';

try {
  process.loadEnvFile();
} catch {
  // DATABASE_URL may already be in the environment (e.g. CI).
}
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('[check-migration-drift] DATABASE_URL is not set — check .env.');
  process.exit(1);
}

const branch = (() => {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'detached-head';
  }
})();

/** `shadow_` + the branch schema's suffix, kept under Postgres's 63-byte identifier limit. */
function shadowSchemaFor(b) {
  const name = `shadow_${schemaNameFor(b).replace(/^dev_/, '')}`;
  if (name.length <= 63) return name;
  return `${name.slice(0, 54)}_${createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
}

const shadowSchema = shadowSchemaFor(branch);
const shadowUrl = withSchema(baseUrl, shadowSchema);
// DATABASE_URL = the shadow too: Prisma takes the datamodel's schema from
// the datasource URL, and it must match the schema the migrations replay
// into, or every object reads as "added".
const run = (args, input) =>
  spawnSync('npx', ['prisma', ...args], {
    stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    input,
    shell: true,
    env: { ...process.env, DATABASE_URL: shadowUrl },
  });

console.error(`[check-migration-drift] shadow schema "${shadowSchema}" (disposable, dropped afterwards)`);
let status = 1;
try {
  const diff = run([
    'migrate', 'diff',
    '--from-migrations', 'prisma/migrations',
    '--to-schema-datamodel', 'prisma/schema.prisma',
    '--shadow-database-url', `"${shadowUrl}"`,
    '--exit-code',
  ]);
  status = diff.status ?? 1;
  console.error(status === 0 ? '[check-migration-drift] no drift' : status === 2 ? '[check-migration-drift] DRIFT — see the diff above' : '[check-migration-drift] prisma migrate diff failed');
} finally {
  run(['db', 'execute', '--url', `"${shadowUrl}"`, '--stdin'], `DROP SCHEMA IF EXISTS "${shadowSchema}" CASCADE;`);
}
process.exit(status);
