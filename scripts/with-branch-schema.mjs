#!/usr/bin/env node
/**
 * Runs a command with DATABASE_URL rewritten to point at a Postgres schema
 * derived from the current git branch, instead of whatever schema the raw
 * .env value names (normally `public`).
 *
 * This exists because every worktree in this repo shares one Supabase
 * database. Two separate incidents happened before this script did:
 * a migration run in one branch's worktree silently dropped a column
 * another branch's feature depended on, because Prisma assumed the live
 * database should match only its own branch's migration history. Per-branch
 * schemas make that structurally impossible — each branch's tables live in
 * their own namespace, so one branch's `prisma migrate dev` can no longer
 * see (let alone alter or drop) another branch's tables at all.
 *
 * Usage: node scripts/with-branch-schema.mjs <command...>
 *   e.g. node scripts/with-branch-schema.mjs npx prisma migrate dev
 *        node scripts/with-branch-schema.mjs "kill-port 4000 && tsx watch server/src/index.ts"
 *
 * The rest of argv is joined back into a single string and handed to a real
 * shell (bash) rather than spawned as a bare argv array, so that shell
 * syntax already relied on elsewhere in this repo's npm scripts (&&, quoted
 * glob patterns) keeps working unchanged inside the wrapped command.
 */
import { spawnSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

try {
  // Node 20.12+/21.7+: loads .env into process.env without extra deps.
  process.loadEnvFile();
} catch {
  // No .env file, or already loaded some other way — DATABASE_URL may
  // already be present in the environment (e.g. CI). Not fatal on its own;
  // the check below is what actually enforces it's set.
}

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'detached-head';
  }
}

/**
 * Postgres identifiers are limited to 63 bytes. Branch names in this repo
 * are well under that today, but this must not silently produce a broken
 * (truncated, possibly colliding) identifier for some future long branch
 * name — fail loudly toward a still-valid, still-unique name instead via a
 * short content hash, rather than a bare truncation that two different long
 * branch names could collide on.
 */
export function schemaNameFor(branch) {
  const base = 'dev_' + branch.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (Buffer.byteLength(base, 'utf8') <= 63) return base;
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 8);
  return base.slice(0, 63 - 1 - hash.length) + '_' + hash;
}

export function withSchema(rawUrl, schema, connectionLimit) {
  const u = new URL(rawUrl);
  u.searchParams.set('schema', schema);
  // Supabase's session-mode pooler on this project caps at 15 real backend
  // connections, and Prisma's per-client default pool defaults to
  // `num_cpus * 2 + 1` — one test file's PrismaClient alone can exceed that
  // on a many-core machine. This repo's test suite constructs 13+ separate
  // PrismaClient instances (one per test file, none of them disconnect
  // until the whole run ends), so left uncapped a full `test:server` run
  // reliably exhausts the pool partway through with real connection errors,
  // not assertion failures — this predates schema-per-branch and isn't
  // caused by it, but capping it here is what makes "run the full suite to
  // confirm nothing broke" actually reliable. A leading --connection-limit=N
  // flag lets a specific npm script opt into a tight cap (test:server
  // does); everything else (server:dev, prisma:migrate, ...) is left at
  // Prisma's own default by simply not passing the flag.
  if (connectionLimit) {
    u.searchParams.set('connection_limit', connectionLimit);
  }
  return u.toString();
}

function main() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    console.error('[with-branch-schema] DATABASE_URL is not set — check .env.');
    process.exit(1);
  }

  const rest = process.argv.slice(2);
  let connectionLimit;
  if (rest[0]?.startsWith('--connection-limit=')) {
    connectionLimit = rest.shift().split('=')[1];
  }

  const branch = currentBranch();
  const schema = schemaNameFor(branch);
  const scopedUrl = withSchema(baseUrl, schema, connectionLimit);

  console.error(`[with-branch-schema] branch "${branch}" -> schema "${schema}"${connectionLimit ? ` (connection_limit=${connectionLimit})` : ''}`);

  const command = rest.join(' ');
  if (!command) {
    console.error('[with-branch-schema] usage: node scripts/with-branch-schema.mjs [--connection-limit=N] <command...>');
    process.exit(1);
  }

  const result = spawnSync('bash', ['-c', command], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: scopedUrl },
  });
  process.exit(result.status ?? 1);
}

// Only run when invoked directly (`node scripts/with-branch-schema.mjs ...`),
// not when imported by a test for schemaNameFor/withSchema.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
