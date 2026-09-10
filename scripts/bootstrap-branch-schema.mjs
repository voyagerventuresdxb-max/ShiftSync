#!/usr/bin/env node
/**
 * One-time (or re-runnable) setup for a worktree's dedicated Postgres
 * schema: creates the schema derived from the current branch, applies that
 * branch's own migrations into it, then copies existing dev data in from
 * `public` — read-only against `public`, so this never touches the data
 * every other worktree is still using while this rolls out.
 *
 * Column sets can legitimately differ between branches (that's the whole
 * point of per-branch schemas — e.g. one branch has
 * `locations.last_vision_fallback_used_at`, another doesn't yet). This
 * script copies only the column INTERSECTION per table, and prints every
 * table/column difference it finds — it does not try to reconcile them,
 * per the standing rule that divergence gets surfaced, not silently papered
 * over.
 *
 * Usage: node scripts/bootstrap-branch-schema.mjs
 * (run from inside the worktree whose branch should get its own schema)
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { schemaNameFor } from './with-branch-schema.mjs';

function branch() {
  return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
}

function run(cmd, env) {
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });
}

async function tablesIn(client, schema) {
  const rows = await client.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
    schema,
  );
  return rows.map((r) => r.table_name);
}

async function columnsOf(client, schema, table) {
  // udt_name/data_type let us detect enum columns: Postgres enums are
  // schema-scoped types (CREATE TYPE ... AS ENUM runs per-migration, once
  // per schema), so `public."Foo"` and `dev_x."Foo"` are NOT the same type
  // even with an identical name — a bare positional INSERT...SELECT across
  // schemas fails on any enum column unless it's cast through text first.
  const rows = await client.$queryRawUnsafe(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    schema,
    table,
  );
  return rows.map((r) => ({ name: r.column_name, isEnum: r.data_type === 'USER-DEFINED', udtName: r.udt_name }));
}

async function main() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    console.error('DATABASE_URL is not set — check .env.');
    process.exit(1);
  }

  const b = branch();
  const schema = schemaNameFor(b);
  console.log(`Bootstrapping schema "${schema}" for branch "${b}"`);

  const adminUrl = new URL(baseUrl);
  adminUrl.searchParams.set('schema', 'public');
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });

  await admin.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  console.log(`  schema "${schema}" ready`);

  console.log('  applying this branch\'s migrations into it (prisma migrate deploy)...');
  const scopedUrl = new URL(baseUrl);
  scopedUrl.searchParams.set('schema', schema);
  run('npx prisma migrate deploy', { DATABASE_URL: scopedUrl.toString() });

  const publicTables = await tablesIn(admin, 'public');
  const targetTables = await tablesIn(admin, schema);
  const publicSet = new Set(publicTables);
  const targetSet = new Set(targetTables);

  const onlyInPublic = publicTables.filter((t) => !targetSet.has(t));
  const onlyInTarget = targetTables.filter((t) => !publicSet.has(t));
  if (onlyInPublic.length) console.log(`  tables in public but NOT in "${schema}" (this branch is behind, or these are unrelated): ${onlyInPublic.join(', ')}`);
  if (onlyInTarget.length) console.log(`  tables in "${schema}" but NOT in public (this branch is ahead): ${onlyInTarget.join(', ')}`);

  // _prisma_migrations is Prisma's own bookkeeping table, not dev data —
  // `migrate deploy` above already gave the target schema its own correct
  // history; copying public's history into it would just be confusing
  // (different migration sets across branches, duplicate/foreign rows).
  const shared = publicTables.filter((t) => targetSet.has(t) && t !== '_prisma_migrations');
  console.log(`  copying data for ${shared.length} shared tables (intersection of columns only)...`);

  await admin.$executeRawUnsafe('SET session_replication_role = replica');
  try {
    for (const table of shared) {
      const publicCols = await columnsOf(admin, 'public', table);
      const targetCols = await columnsOf(admin, schema, table);
      const publicByName = new Map(publicCols.map((c) => [c.name, c]));
      const targetByName = new Map(targetCols.map((c) => [c.name, c]));
      const sharedNames = publicCols.map((c) => c.name).filter((n) => targetByName.has(n));
      const onlyPub = publicCols.map((c) => c.name).filter((n) => !targetByName.has(n));
      const onlyTgt = targetCols.map((c) => c.name).filter((n) => !publicByName.has(n));
      if (onlyPub.length) console.log(`    ${table}: public-only columns not copied: ${onlyPub.join(', ')}`);
      if (onlyTgt.length) console.log(`    ${table}: ${schema}-only columns left at their defaults: ${onlyTgt.join(', ')}`);
      if (sharedNames.length === 0) {
        console.log(`    ${table}: no shared columns, skipped`);
        continue;
      }
      const insertCols = sharedNames.map((n) => `"${n}"`).join(', ');
      // Enum columns are schema-scoped types in Postgres — public."Foo" and
      // dev_x."Foo" aren't interchangeable even with the same name, so an
      // enum source column has to round-trip through text and get cast to
      // the TARGET schema's own version of that type on the way in.
      const selectCols = sharedNames
        .map((n) => {
          const targetCol = targetByName.get(n);
          return targetCol.isEnum ? `("${n}"::text)::"${schema}"."${targetCol.udtName}"` : `"${n}"`;
        })
        .join(', ');
      const count = await admin.$executeRawUnsafe(
        `INSERT INTO "${schema}"."${table}" (${insertCols}) SELECT ${selectCols} FROM "public"."${table}" ON CONFLICT DO NOTHING`,
      );
      console.log(`    ${table}: ${count} row(s) copied`);
    }
  } finally {
    await admin.$executeRawUnsafe('SET session_replication_role = origin');
  }

  await admin.$disconnect();
  console.log(`Done. "${schema}" is now a self-contained copy of this branch's data, independent of public.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
