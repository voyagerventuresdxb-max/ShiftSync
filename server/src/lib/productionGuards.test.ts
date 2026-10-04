import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { GEMINI_BASE_URL_OVERRIDES, checkProductionEnv, isProduction } from './productionGuards.js';

// Pure function over an env object — no process.env mutation, no DB.
const PROD_SIGNALS = [{ NODE_ENV: 'production' }, { RAILWAY_ENVIRONMENT_NAME: 'production' }];
const ALL_FLAGS_ON = { ALLOW_DEV_OTP_ECHO: 'true', ALLOW_DEV_OTP_BYPASS: 'true', ALLOW_DEV_ERROR_INJECTION: 'true', GEMINI_BASE_URL: 'http://127.0.0.1:4599' };

test('production is NODE_ENV=production or RAILWAY_ENVIRONMENT_NAME=production, nothing else', () => {
  for (const signal of PROD_SIGNALS) assert.equal(isProduction(signal), true, JSON.stringify(signal));
  assert.equal(isProduction({}), false);
  assert.equal(isProduction({ NODE_ENV: 'development', RAILWAY_ENVIRONMENT_NAME: 'staging' }), false);
});

test('outside production every flag is tolerated', () => {
  for (const env of [{}, { NODE_ENV: 'development' }, { RAILWAY_ENVIRONMENT_NAME: 'pr-12' }]) {
    assert.doesNotThrow(() => checkProductionEnv({ ...env, ...ALL_FLAGS_ON, ECHO_ALLOWED_PHONES: '050 123 4567' }));
  }
});

for (const signal of PROD_SIGNALS) {
  const label = Object.entries(signal)[0]!.join('=');

  test(`${label}: refuses to start with ALLOW_DEV_OTP_ECHO=true and no valid number in ECHO_ALLOWED_PHONES`, () => {
    for (const list of [undefined, '', ' , ', 'not a phone, 04 345 6789']) {
      assert.throws(
        () => checkProductionEnv({ ...signal, ALLOW_DEV_OTP_ECHO: 'true', ECHO_ALLOWED_PHONES: list }),
        (err: unknown) => err instanceof Error && /refusing to start/i.test(err.message) && err.message.includes('ECHO_ALLOWED_PHONES'),
        `ECHO_ALLOWED_PHONES=${JSON.stringify(list)}`,
      );
    }
  });

  for (const flag of ['ALLOW_DEV_OTP_BYPASS', 'ALLOW_DEV_ERROR_INJECTION']) {
    test(`${label}: refuses to start with ${flag}=true`, () => {
      assert.throws(() => checkProductionEnv({ ...signal, [flag]: 'true' }), (err: unknown) => err instanceof Error && err.message.includes(flag));
    });
  }

  test(`${label}: refuses to start with GEMINI_BASE_URL set to anything, so voice AI traffic is never redirected`, () => {
    for (const url of ['http://127.0.0.1:4599', 'https://example.com', 'false']) {
      assert.throws(
        () => checkProductionEnv({ ...signal, GEMINI_BASE_URL: url }),
        (err: unknown) => err instanceof Error && err.message.includes('GEMINI_BASE_URL'),
        `GEMINI_BASE_URL=${url}`,
      );
    }
    assert.deepEqual(checkProductionEnv({ ...signal, GEMINI_BASE_URL: ' ' }), { warnings: [] });
  });

  test(`${label}: refuses to start with PUSH_TRANSPORT set to anything (push would be recorded, not delivered)`, () => {
    for (const value of ['record', 'true', 'anything']) {
      assert.throws(
        () => checkProductionEnv({ ...signal, PUSH_TRANSPORT: value }),
        (err: unknown) => err instanceof Error && err.message.includes('PUSH_TRANSPORT'),
        `PUSH_TRANSPORT=${value}`,
      );
    }
    assert.deepEqual(checkProductionEnv({ ...signal, PUSH_TRANSPORT: '' }), { warnings: [] });
  });

  test(`${label}: boots with the echo on and a valid allowlist, warning only about the junk entry`, () => {
    const { warnings } = checkProductionEnv({ ...signal, ALLOW_DEV_OTP_ECHO: 'true', ECHO_ALLOWED_PHONES: '050 123 4567, junk' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"junk"/);
  });

  test(`${label}: boots with every flag off`, () => {
    assert.deepEqual(checkProductionEnv({ ...signal, ALLOW_DEV_OTP_BYPASS: 'false', ALLOW_DEV_ERROR_INJECTION: '1' }), { warnings: [] });
  });

  test(`${label}: refuses to start with SMS_OTP_ENABLED=true and the provider not configured (every sign-in would fail)`, () => {
    assert.throws(
      () => checkProductionEnv({ ...signal, SMS_OTP_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'ACfake' }),
      (err: unknown) => err instanceof Error && /SMS_OTP_ENABLED=true but TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID or SMS_SENDER_ID is not set/.test(err.message),
    );
    const configured = { SMS_OTP_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'fake', SMS_SENDER_ID: 'ShiftSync' };
    assert.deepEqual(checkProductionEnv({ ...signal, ...configured }), { warnings: [] });
    // Off (the default), the provider settings are not needed.
    assert.deepEqual(checkProductionEnv({ ...signal, SMS_OTP_ENABLED: 'false' }), { warnings: [] });
  });
}

test('outside production, SMS on with the provider not configured is a warning', () => {
  assert.deepEqual(checkProductionEnv({ SMS_OTP_ENABLED: 'true' }).warnings, [
    'SMS_OTP_ENABLED=true but TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID or SMS_SENDER_ID is not set — every code request would fail.',
  ]);
});

test('one error names every offending setting, so a single redeploy fixes all of them', () => {
  assert.throws(
    () => checkProductionEnv({ NODE_ENV: 'production', ...ALL_FLAGS_ON }),
    (err: unknown) =>
      err instanceof Error &&
      ['ECHO_ALLOWED_PHONES', 'ALLOW_DEV_OTP_BYPASS', 'ALLOW_DEV_ERROR_INJECTION', 'GEMINI_BASE_URL'].every((s) => err.message.includes(s)),
  );
});

test('outside production, an echo with no valid allowlist entry warns instead of silently echoing nothing', () => {
  const { warnings } = checkProductionEnv({ ALLOW_DEV_OTP_ECHO: 'true', ECHO_ALLOWED_PHONES: 'nope' });
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /"nope" is not a valid mobile number/);
  assert.match(warnings.join('\n'), /no code will be echoed/);
});

/** Runs the real server entry point with `env`; resolves with its exit code, or 'listening' once it binds. */
function boot(env: Record<string, string>): Promise<{ outcome: number | 'listening'; output: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'index.ts')], {
    // Every relevant var set explicitly, so a local .env (dotenv never overrides) can't change the outcome.
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RAILWAY_ENVIRONMENT_NAME: 'local',
      ALLOW_DEV_OTP_ECHO: 'false',
      ALLOW_DEV_OTP_BYPASS: 'false',
      ALLOW_DEV_ERROR_INJECTION: 'false',
      GEMINI_BASE_URL: '',
      ECHO_ALLOWED_PHONES: 'none',
      PORT: '0',
      ...env,
    },
  });
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server neither exited nor listened in 60s:\n${output}`));
    }, 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('ShiftSync API listening')) {
        clearTimeout(timer);
        child.kill();
        resolve({ outcome: 'listening', output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ outcome: code ?? -1, output });
    });
  });
}

test('the server entry point exits non-zero before listening when production is unsafe, and boots when it is safe', async () => {
  const refused = await boot({ RAILWAY_ENVIRONMENT_NAME: 'production', ALLOW_DEV_OTP_ECHO: 'true' });
  assert.equal(refused.outcome, 1, refused.output);
  assert.match(refused.output, /\[startup\] Refusing to start in production/);
  assert.doesNotMatch(refused.output, /listening/);

  const safe = await boot({ NODE_ENV: 'production', ALLOW_DEV_OTP_ECHO: 'true', ECHO_ALLOWED_PHONES: '+971501234567' });
  assert.equal(safe.outcome, 'listening', safe.output);
});

test('every Gemini/Vertex base-URL override (ours and the SDK\'s own) refuses production boot; blank values are tolerated', () => {
  assert.deepEqual([...GEMINI_BASE_URL_OVERRIDES], ['GEMINI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL']);
  for (const name of GEMINI_BASE_URL_OVERRIDES) {
    assert.throws(
      () => checkProductionEnv({ NODE_ENV: 'production', [name]: 'https://example.invalid/v1' }),
      (err: unknown) => err instanceof Error && err.message.includes(name),
      `${name} must refuse boot`,
    );
    assert.throws(
      () => checkProductionEnv({ RAILWAY_ENVIRONMENT_NAME: 'production', [name]: 'http://127.0.0.1:4599' }),
      (err: unknown) => err instanceof Error && err.message.includes(name),
      `${name} must refuse boot under the Railway signal too`,
    );
    assert.deepEqual(checkProductionEnv({ NODE_ENV: 'production', [name]: '   ' }), { warnings: [] }, `${name} blank is not set`);
    assert.deepEqual(checkProductionEnv({ NODE_ENV: 'development', [name]: 'http://127.0.0.1:4599' }), { warnings: [] }, `${name} is fine outside production`);
  }
});
