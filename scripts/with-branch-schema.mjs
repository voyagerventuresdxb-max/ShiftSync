#!/usr/bin/env node
/**
 * Runs a command with DATABASE_URL rewritten to point at a Postgres schema
 * derived from the current git branch, instead of whatever schema the raw
 * .env value names (normally `public`).
 *
 * This exists because every worktree on a machine shares one Postgres (the
 * local docker one from `npm run db:setup` — see docker-compose.yml)
 * database. Two separate incidents happened before this script did:
 * a migration run in one branch's worktree silently dropped a column
 * another branch's feature depended on, because Prisma assumed the live
 * database should match only its own branch's migration history. Per-branch
 * schemas make that structurally impossible — each branch's tables live in
 * their own namespace, so one branch's `prisma migrate dev` can no longer
 * see (let alone alter or drop) another branch's tables at all.
 *
 * Usage: node scripts/with-branch-schema.mjs [--connection-limit=N] [--confirm-reset=<schema>] <command...>
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

/**
 * Safeguard (2026-09-30, after a real incident): refuses commands that would
 * WIPE a live schema through this wrapper, and returns the reason.
 *
 * The incident: `with-branch-schema "prisma migrate diff ... --shadow-database-url
 * \"$DATABASE_URL\""` — inside this wrapper $DATABASE_URL IS the branch's
 * live schema, and Prisma RESETS whatever the shadow URL points at (drops
 * every object in it, then replays the migrations). The branch's dev data was
 * gone in one command. Nothing prompted: Prisma treats the shadow database
 * as disposable by definition, and this wrapper passed the command through.
 *
 * Rules:
 *  1. A --shadow-database-url must be a literal URL naming a disposable
 *     schema (`shadow_*`) or a different database — never $DATABASE_URL, and
 *     never `public` or a branch schema. (For a drift check, use
 *     `npm run prisma:check-drift`, which does this safely.)
 *  2. `prisma migrate reset` / `db push --force-reset` wipe the target schema
 *     by design; they need an explicit `--confirm-reset=<schema>` naming the
 *     schema they will wipe.
 */
export function destructiveCommandReason(command, scopedUrl, confirmedResetSchema) {
  const target = new URL(scopedUrl);
  const targetSchema = target.searchParams.get('schema') || 'public';

  const shadow = command.match(/--shadow-database-url(?:=|\s+)("[^"]*"|'[^']*'|\S+)/);
  if (shadow) {
    const raw = shadow[1].replace(/^["']|["']$/g, '');
    if (/\$\{?DATABASE_URL\b|%DATABASE_URL%/.test(raw)) {
      return `--shadow-database-url is $DATABASE_URL, which inside this wrapper is the live "${targetSchema}" schema — Prisma resets the shadow database. Use \`npm run prisma:check-drift\` instead.`;
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      return `--shadow-database-url "${raw}" is not a literal URL, so it can't be checked — refusing rather than risk resetting a live schema.`;
    }
    const shadowSchema = url.searchParams.get('schema') || 'public';
    const sameDatabase = url.host === target.host && url.pathname === target.pathname;
    if (sameDatabase && !shadowSchema.startsWith('shadow_')) {
      return `--shadow-database-url points at schema "${shadowSchema}" in the live database — Prisma resets the shadow database. Use a disposable "shadow_*" schema (see \`npm run prisma:check-drift\`).`;
    }
  }

  if (/\bmigrate\s+reset\b|--force-reset\b/.test(command) && confirmedResetSchema !== targetSchema) {
    return `this command wipes schema "${targetSchema}". Re-run with --confirm-reset=${targetSchema} if that is really what you want.`;
  }
  return null;
}

function main() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    console.error('[with-branch-schema] DATABASE_URL is not set — check .env.');
    process.exit(1);
  }

  const rest = process.argv.slice(2);
  let connectionLimit;
  let confirmedResetSchema;
  while (rest[0]?.startsWith('--connection-limit=') || rest[0]?.startsWith('--confirm-reset=')) {
    const flag = rest.shift();
    if (flag.startsWith('--connection-limit=')) connectionLimit = flag.split('=')[1];
    else confirmedResetSchema = flag.split('=')[1];
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

  const refusal = destructiveCommandReason(command, scopedUrl, confirmedResetSchema);
  if (refusal) {
    console.error(`[with-branch-schema] REFUSED: ${refusal}`);
    process.exit(2);
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
