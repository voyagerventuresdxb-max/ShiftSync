import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destructiveCommandReason } from './with-branch-schema.mjs';

const LIVE = 'postgresql://dev:dev@localhost:5432/shiftsync_dev?schema=dev_feat_x';

test('refuses the exact command that wiped a branch schema (2026-09-30): shadow = $DATABASE_URL', () => {
  const cmd = 'npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --exit-code';
  assert.match(destructiveCommandReason(cmd, LIVE) ?? '', /live "dev_feat_x" schema/);
  for (const v of ['$DATABASE_URL', '${DATABASE_URL}', "'$DATABASE_URL'", '%DATABASE_URL%']) {
    assert.ok(destructiveCommandReason(`prisma migrate diff --shadow-database-url ${v}`, LIVE), v);
  }
  assert.ok(destructiveCommandReason('prisma migrate diff --shadow-database-url="$DATABASE_URL"', LIVE), '= form');
});

test('refuses a shadow URL that is a live schema of the same database (branch, public, or no schema)', () => {
  for (const url of [LIVE, 'postgresql://dev:dev@localhost:5432/shiftsync_dev?schema=public', 'postgresql://dev:dev@localhost:5432/shiftsync_dev', 'postgresql://dev:dev@localhost:5432/shiftsync_dev?schema=dev_other_branch']) {
    assert.ok(destructiveCommandReason(`prisma migrate diff --shadow-database-url "${url}"`, LIVE), url);
  }
  assert.ok(destructiveCommandReason('prisma migrate diff --shadow-database-url $SOME_OTHER_VAR', LIVE), 'unresolvable → refuse');
});

test('allows a disposable shadow_* schema or a different database', () => {
  assert.equal(destructiveCommandReason('prisma migrate diff --shadow-database-url "postgresql://dev:dev@localhost:5432/shiftsync_dev?schema=shadow_feat_x"', LIVE), null);
  assert.equal(destructiveCommandReason('prisma migrate diff --shadow-database-url "postgresql://dev:dev@localhost:5432/scratch_db"', LIVE), null);
});

test('migrate reset / --force-reset need --confirm-reset naming the schema they wipe', () => {
  assert.ok(destructiveCommandReason('npx prisma migrate reset --force', LIVE));
  assert.ok(destructiveCommandReason('npx prisma db push --force-reset', LIVE));
  assert.ok(destructiveCommandReason('npx prisma migrate reset --force', LIVE, 'public'), 'confirming the wrong schema does not count');
  assert.equal(destructiveCommandReason('npx prisma migrate reset --force', LIVE, 'dev_feat_x'), null);
});

test('everyday commands pass untouched', () => {
  for (const cmd of ['npx prisma migrate deploy', 'npx prisma migrate dev', 'npx prisma generate', 'tsx watch server/src/index.ts', 'playwright test', "node --import tsx --test 'server/src/**/*.test.ts'"]) {
    assert.equal(destructiveCommandReason(cmd, LIVE), null, cmd);
  }
});
