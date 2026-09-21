#!/usr/bin/env node
/**
 * One-command local dev database. Idempotent — safe to re-run any time.
 *
 *   npm run db:setup
 *   POSTGRES_PORT=5433 npm run db:setup    # if 5432 is taken on this machine
 *
 * What it does, in order:
 *   1. Makes sure this worktree has a `.env` with a DATABASE_URL — copies
 *      `.env.example` (which ships the real local credentials) if there is
 *      no `.env` yet, or appends DATABASE_URL if `.env` exists without one.
 *      Nothing is ever overwritten.
 *   2. Starts the Postgres container from docker-compose.yml if it isn't
 *      running, and waits until it accepts connections.
 *   3. `prisma generate` (the client is schema-agnostic).
 *   4. Migrates + seeds the `public` schema — the template every branch
 *      schema is bootstrapped from (scripts/bootstrap-branch-schema.mjs).
 *   5. Bootstraps this worktree's own `dev_<branch>` schema and seeds it, so
 *      `npm run dev:all` / `test:server` / `test:e2e` work immediately.
 *
 * If DATABASE_URL in `.env` already points somewhere that isn't localhost, the
 * docker step is skipped and that database is used as-is (with a warning) —
 * this script never silently repoints an existing configuration.
 *
 * Replaces any previous "pull DATABASE_URL from Vercel" step for local dev:
 * no cloud auth, no tokens, no manual .env edits.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaNameFor, withSchema } from './with-branch-schema.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.POSTGRES_PORT || '5432';
const LOCAL_URL = `postgresql://dev:dev@localhost:${PORT}/shiftsync_dev?schema=public`;
const READY_TIMEOUT_MS = 60_000;

function step(msg) {
  console.log(`\n[setup-local-db] ${msg}`);
}
function fail(msg) {
  console.error(`\n[setup-local-db] ERROR: ${msg}`);
  process.exit(1);
}
/** Runs a command with inherited stdio; returns its exit status. */
function run(cmd, env = {}) {
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });
  return r.status ?? 1;
}
/** Runs a command quietly; returns { status, out }. */
function capture(cmd, env = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', cwd: root, env: { ...process.env, ...env } });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 1. .env ------------------------------------------------------------------
const envPath = join(root, '.env');
if (!existsSync(envPath)) {
  copyFileSync(join(root, '.env.example'), envPath);
  step('.env created from .env.example');
}
if (!/^DATABASE_URL=/m.test(readFileSync(envPath, 'utf8'))) {
  writeFileSync(envPath, `${readFileSync(envPath, 'utf8').replace(/\s*$/, '')}\n\nDATABASE_URL="${LOCAL_URL}"\n`);
  step('DATABASE_URL added to .env');
}
process.loadEnvFile(envPath);
const baseUrl = process.env.DATABASE_URL;
let host;
try {
  host = new URL(baseUrl).host;
} catch {
  fail('DATABASE_URL in .env is not a valid URL — fix or delete that line and re-run.');
}
const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);

// 2. Postgres container ----------------------------------------------------
if (isLocal) {
  if (capture('docker compose version').status !== 0) {
    fail('Docker is not available. Install Docker Desktop (https://docs.docker.com/desktop/), start it, and re-run.');
  }
  step(`starting postgres container (host port ${PORT}; already running is fine)`);
  if (run('docker compose up -d --wait postgres', { POSTGRES_PORT: PORT }) !== 0) fail('docker compose up failed');

  step('waiting for postgres to accept connections');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (capture('docker compose exec -T postgres pg_isready -U dev -d shiftsync_dev', { POSTGRES_PORT: PORT }).status === 0) {
      ready = true;
      break;
    }
    sleep(1000);
  }
  if (!ready) fail(`postgres did not become ready within ${READY_TIMEOUT_MS / 1000}s — check \`docker compose logs postgres\``);
} else {
  step(`DATABASE_URL points at "${host}" (not local) — skipping docker, using that database as-is`);
}

// 3. prisma generate -------------------------------------------------------
step('prisma generate');
if (run('npx prisma generate') !== 0) fail('prisma generate failed');

// 4. public schema: migrate + seed ------------------------------------------
const publicUrl = withSchema(baseUrl, 'public');
step('migrating public schema (prisma migrate deploy)');
if (run('npx prisma migrate deploy', { DATABASE_URL: publicUrl }) !== 0) fail('migrate deploy (public) failed');
step('seeding public schema (idempotent upserts)');
if (run('npx tsx server/scripts/seed-test-data.ts', { DATABASE_URL: publicUrl }) !== 0) fail('seed (public) failed');

// 5. this branch's schema ----------------------------------------------------
const branch = capture('git rev-parse --abbrev-ref HEAD').out || 'detached-head';
const schema = schemaNameFor(branch);
step(`bootstrapping branch schema "${schema}" (branch "${branch}")`);
if (run('node scripts/bootstrap-branch-schema.mjs') !== 0) fail('bootstrap-branch-schema failed');
// bootstrap copies public's rows in, but only for a schema created before public
// was seeded would that leave gaps — the seed is an upsert, so re-running it
// directly against the branch schema is free and closes that case.
step(`seeding "${schema}"`);
if (run('node scripts/with-branch-schema.mjs "tsx server/scripts/seed-test-data.ts"') !== 0) fail('seed (branch schema) failed');

console.log(`
[setup-local-db] ✔ ready
  database : ${isLocal ? `shiftsync_dev @ localhost:${PORT}  (container: shiftsync-dev-postgres)` : host}
  schema   : ${schema}  (branch: ${branch})
  next     : npm run dev:all   ·   npm run test:server   ·   npm run test:e2e
`);
