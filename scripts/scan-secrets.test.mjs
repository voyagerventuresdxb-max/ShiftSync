import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from './scan-secrets.mjs';

const SCRIPT = fileURLToPath(new URL('./scan-secrets.mjs', import.meta.url));

// Fake secrets are assembled at runtime so this file never contains a secret-shaped string.
const j = (...parts) => parts.join('');
const FAKES = {
  'google-api-key': j('AI', 'za', 'SyFAKEfake'),
  'google-aq-key': j('AQ', '.', 'AbFAKE'),
  'private-key-block': j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
  'service-account-key-id': j('"private_key_id": "', '0123456789abcdef0123', '"'),
  'bearer-token': j('Authorization: Bearer ', 'abcdefghij', 'KLMNOPQRST', '1234'),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcdefghijklmnop'),
  'aws-access-key-id': j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  'github-token': j('gh', 'p_', 'a'.repeat(36)),
  'slack-token': j('xo', 'xb-', '1234567890-abc'),
  'stripe-live-key': j('sk', '_live_', 'a'.repeat(24)),
  'openai-anthropic-key': j('sk', '-ant-', 'a'.repeat(30)),
  'npm-token': j('np', 'm_', 'a'.repeat(36)),
  'db-url-with-password': j('postgresql://', 'user:', 's3cretpw', '@db.example.com:5432/app'),
};

test('every rule fires on its fake and reports the rule name and line only', () => {
  for (const [rule, fake] of Object.entries(FAKES)) {
    const hits = scanText(`first line\nconst x = "${fake}";\n`);
    assert.deepEqual(hits, [{ line: 2, rule }], rule);
  }
});

test('a quoted fragment of a key (prefix plus a few characters) is still caught', () => {
  assert.equal(scanText(j('value was `"', 'AI', 'zaSyB…`')).length, 1);
  assert.equal(scanText(j('value was `"', 'AQ', '.Ab8R…`')).length, 1);
});

test('ordinary code and docs do not trip it', () => {
  const clean = [
    'headers: { Authorization: `Bearer ${token}` }',
    'DATABASE_URL="postgresql://dev:dev@localhost:5432/shiftsync_dev?schema=public"',
    'postgresql://<user>:<password>@<host>:5432/<db>',
    'Keys from the Developer API start with `AIza`.',
    'GEMINI_API_KEY is a secret; never commit it.',
    'const sk = "sk-short";',
  ];
  for (const line of clean) assert.deepEqual(scanText(line), [], line);
});

test('the allow marker skips a line', () => {
  assert.deepEqual(scanText(`${FAKES['google-api-key']} // scan-secrets: allow`), []);
});

test('CLI exits 1 on a hit and never prints the matched text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-secrets-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'leak.md'), `note\nkey was ${FAKES['google-api-key']}\n`);
    writeFileSync(join(dir, 'ok.md'), 'nothing here\n');
    let out = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      status = e.status;
      out = `${e.stdout}${e.stderr}`;
    }
    assert.equal(status, 1);
    assert.match(out, /leak\.md:2 {2}google-api-key/);
    assert.ok(!out.includes(FAKES['google-api-key']), 'matched text must not be printed');
    assert.ok(!out.includes('SyFAKE'), 'no part of the match is printed');

    rmSync(join(dir, 'leak.md'));
    const clean = execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    assert.match(clean, /clean: 1 files scanned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
