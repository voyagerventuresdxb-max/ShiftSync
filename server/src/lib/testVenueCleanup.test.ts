import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { TEST_ORG_PREFIXES, checkDatabaseHost, isTestOrgName, parseCliArgs, redactPhone, uploadFilePath } from './testVenueCleanup.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'server', 'scripts', 'cleanup-test-venues.ts');

test('isTestOrgName: exact, case-sensitive prefix only — never a substring, a near miss or a LIKE-wildcard lookalike', () => {
  for (const prefix of TEST_ORG_PREFIXES) {
    assert.equal(isTestOrgName(prefix), true, prefix);
    assert.equal(isTestOrgName(`${prefix} golden-path 1759400000000`), true, prefix);
  }
  assert.equal(isTestOrgName('__deploy-check__ floor plan 2026-09-30'), true, 'issue #53');
  for (const name of [
    '',
    'Il Gattopardo',
    ' __e2e-test__ leading space',
    'x__e2e-test__ prefixed',
    'My __deploy-check__ venue',
    '__E2E-TEST__ upper case',
    'ZZe2e-test__ underscores are LIKE wildcards',
    '_e2e-test__ one underscore',
    '__e2e-test_ one trailing underscore',
    '__dev-otp-echo-test__ names a location, never an org',
  ]) {
    assert.equal(isTestOrgName(name), false, JSON.stringify(name));
  }
});

test('checkDatabaseHost: localhost/127.0.0.1 only; anything else refused with the host named and the password never echoed', () => {
  assert.deepEqual(checkDatabaseHost('postgresql://dev:dev@localhost:5432/shiftsync_dev?schema=dev_x'), { ok: true, host: 'localhost', production: false });
  assert.deepEqual(checkDatabaseHost('postgresql://dev:dev@127.0.0.1/shiftsync_dev'), { ok: true, host: '127.0.0.1', production: false });

  for (const [url, host] of [
    ['postgresql://u:hunter2@postgres.railway.internal:5432/railway', 'postgres.railway.internal'],
    ['postgresql://u:hunter2@aws-0-eu.pooler.supabase.com:6543/postgres', 'aws-0-eu.pooler.supabase.com'],
    ['postgresql://u:hunter2@localhost.evil.example/db', 'localhost.evil.example'],
    ['postgresql://localhost:hunter2@evil.example/db', 'evil.example'],
    ['postgresql://u:hunter2@evil.example/db?host=localhost', 'evil.example'],
    ['postgresql://u:hunter2@[::1]:5432/db', '[::1]'],
    ['postgresql://u:hunter2@10.0.0.5/db', '10.0.0.5'],
  ] as const) {
    const check = checkDatabaseHost(url);
    assert.equal(check.ok, false, url);
    if (!check.ok) {
      assert.ok(check.reason.includes(`"${host}"`), check.reason);
      assert.ok(!check.reason.includes('hunter2'), 'never prints the password');
    }
  }
  assert.deepEqual(checkDatabaseHost(undefined), { ok: false, reason: 'DATABASE_URL is not set.' });
  assert.deepEqual(checkDatabaseHost(''), { ok: false, reason: 'DATABASE_URL is not set.' });
  assert.deepEqual(checkDatabaseHost('not a url'), { ok: false, reason: 'DATABASE_URL is not a valid URL.' });
});

test('checkDatabaseHost: the production override must name the URL host exactly (no port, no partial, not empty)', () => {
  const prod = 'postgresql://u:hunter2@postgres.railway.internal:5432/railway';
  assert.deepEqual(checkDatabaseHost(prod, 'postgres.railway.internal'), { ok: true, host: 'postgres.railway.internal', production: true });
  for (const flag of ['', 'postgres.railway.internal:5432', 'railway.internal', 'postgres', 'localhost', 'POSTGRES.railway.internal ']) {
    assert.equal(checkDatabaseHost(prod, flag).ok, false, JSON.stringify(flag));
  }
  // Passing the flag never loosens anything for a different host, local or not.
  assert.equal(checkDatabaseHost('postgresql://dev:dev@localhost/db', 'postgres.railway.internal').ok, false);
  assert.equal(checkDatabaseHost('postgresql://u@/db?host=/var/run/postgresql', '').ok, false, 'an empty URL host never matches');
});

test('parseCliArgs: dry run by default; --name must still carry a test prefix; unknown flags and positionals are refused', () => {
  assert.deepEqual(parseCliArgs([]), { confirm: false, name: undefined, productionHost: undefined });
  assert.deepEqual(parseCliArgs(['--confirm']), { confirm: true, name: undefined, productionHost: undefined });
  assert.deepEqual(
    parseCliArgs(['--name', '__deploy-check__ floor plan 2026-09-30', '--i-am-running-against-production=postgres.railway.internal']),
    { confirm: false, name: '__deploy-check__ floor plan 2026-09-30', productionHost: 'postgres.railway.internal' },
  );
  assert.throws(() => parseCliArgs(['--name', 'Il Gattopardo']), /does not start with a test prefix/);
  assert.throws(() => parseCliArgs(['--name', '']), /does not start with a test prefix/);
  assert.throws(() => parseCliArgs(['--yes']));
  assert.throws(() => parseCliArgs(['--confirm=true']));
  assert.throws(() => parseCliArgs(['delete-everything']));
  assert.throws(() => parseCliArgs(['--i-am-running-against-production']), 'the override needs a value');
});

test('redactPhone keeps the country code and the last two digits', () => {
  assert.equal(redactPhone('+971501234567'), '+971*******67');
  assert.equal(redactPhone('050 1234567'), '050 *****67');
  assert.equal(redactPhone('12345'), '***45');
});

test('uploadFilePath: only /uploads/<floor-plans|policy-documents>/<file>, always inside the uploads dir', () => {
  const root = resolve('/srv/app/server/uploads');
  assert.equal(uploadFilePath(root, '/uploads/floor-plans/abc.png'), join(root, 'floor-plans', 'abc.png'));
  assert.equal(uploadFilePath(root, '/uploads/policy-documents/1b2c.pdf'), join(root, 'policy-documents', '1b2c.pdf'));
  for (const url of [
    '/uploads/floor-plans/../../../etc/passwd',
    '/uploads/floor-plans/..',
    '/uploads/floor-plans/.',
    '/uploads/floor-plans/',
    '/uploads/floor-plans/a/b.png',
    '/uploads/floor-plans/..\\..\\secret',
    '/uploads/other/abc.png',
    '/uploads/abc.png',
    'uploads/floor-plans/abc.png',
    'https://cdn.example/uploads/floor-plans/abc.png',
    '/uploads/floor-plans/abc.png/../../x',
  ]) {
    assert.equal(uploadFilePath(root, url), null, url);
  }
  const inside = uploadFilePath(root, '/uploads/floor-plans/%2e%2e');
  assert.ok(inside?.startsWith(root + sep), 'an encoded name is just a literal file name inside the dir');
});

test('CLI refuses a non-local DATABASE_URL before building a client or running a query — even with --confirm', () => {
  // `.invalid` can never resolve (RFC 6761): any connection attempt would surface as a different error, not this refusal.
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: 'postgresql://u:hunter2@db.invalid:5432/railway' },
      encoding: 'utf8',
      timeout: 60_000,
    });

  const plain = run(['--confirm']);
  assert.equal(plain.status, 2, plain.stderr);
  assert.match(plain.stderr, /^REFUSED: DATABASE_URL's host is "db\.invalid", not localhost or 127\.0\.0\.1\./);
  assert.equal(plain.stdout, '', 'no plan printed, so no query ran');
  assert.ok(!plain.stderr.includes('hunter2'));

  const wrongOverride = run(['--confirm', '--i-am-running-against-production=postgres.railway.internal']);
  assert.equal(wrongOverride.status, 2, wrongOverride.stderr);
  assert.match(wrongOverride.stderr, /does not match DATABASE_URL's host "db\.invalid"/);
  assert.equal(wrongOverride.stdout, '');

  const badName = run(['--name', 'Il Gattopardo']);
  assert.equal(badName.status, 2);
  assert.match(badName.stderr, /does not start with a test prefix/);
});
