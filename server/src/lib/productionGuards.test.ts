import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProductionEnv, FORBIDDEN_IN_PRODUCTION } from './productionGuards.js';

// Pure function over an env object — no process.env mutation, no DB.
const PROD_OK = { NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://app.example' };

test('outside production every flag is tolerated and nothing is reported', () => {
  const env = { NODE_ENV: 'development', ALLOW_DEV_OTP_BYPASS: 'true', ALLOW_DEV_ERROR_INJECTION: 'true', ALLOW_DEV_OTP_ECHO: 'true' };
  assert.deepEqual(checkProductionEnv(env), { warnings: [] });
  // NODE_ENV unset is not production either — the flags are opt-in, so this
  // must not refuse a plain local `tsx server/src/index.ts`.
  assert.deepEqual(checkProductionEnv({ ALLOW_DEV_OTP_BYPASS: 'true', FRONTEND_ORIGIN: 'x' }), { warnings: [] });
});

test('production with a clean env boots with no warnings', () => {
  assert.deepEqual(checkProductionEnv(PROD_OK), { warnings: [] });
});

for (const flag of FORBIDDEN_IN_PRODUCTION) {
  test(`production refuses to start with ${flag}=true and names the flag`, () => {
    assert.throws(
      () => checkProductionEnv({ ...PROD_OK, [flag]: 'true' }),
      (err: unknown) => err instanceof Error && err.message.includes(flag) && /refusing to start/i.test(err.message),
    );
  });

  test(`${flag} set to anything but the literal 'true' does not trip the guard`, () => {
    assert.deepEqual(checkProductionEnv({ ...PROD_OK, [flag]: '1' }), { warnings: [] });
    assert.deepEqual(checkProductionEnv({ ...PROD_OK, [flag]: 'false' }), { warnings: [] });
  });
}

test('production refuses to start without FRONTEND_ORIGIN (unset or blank)', () => {
  assert.throws(() => checkProductionEnv({ NODE_ENV: 'production' }), /FRONTEND_ORIGIN/);
  assert.throws(() => checkProductionEnv({ NODE_ENV: 'production', FRONTEND_ORIGIN: '   ' }), /FRONTEND_ORIGIN/);
});

test('one error names every offending setting, so a single redeploy fixes all of them', () => {
  assert.throws(
    () => checkProductionEnv({ NODE_ENV: 'production', ALLOW_DEV_OTP_BYPASS: 'true', ALLOW_DEV_ERROR_INJECTION: 'true' }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes('ALLOW_DEV_OTP_BYPASS') &&
      err.message.includes('ALLOW_DEV_ERROR_INJECTION') &&
      err.message.includes('FRONTEND_ORIGIN'),
  );
});

test('production with ALLOW_DEV_OTP_ECHO=true still boots but returns a loud warning', () => {
  const { warnings } = checkProductionEnv({ ...PROD_OK, ALLOW_DEV_OTP_ECHO: 'true' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /ALLOW_DEV_OTP_ECHO/);
  assert.match(warnings[0]!, /log in as that person/i);
});
