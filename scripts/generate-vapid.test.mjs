import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const SCRIPT = fileURLToPath(new URL('./generate-vapid.mjs', import.meta.url));

test('prints a key pair web-push accepts, plus the three Railway variable names', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  const publicKey = out.match(/^ {2}VAPID_PUBLIC_KEY=(\S+)$/m)?.[1];
  const privateKey = out.match(/^ {2}VAPID_PRIVATE_KEY=(\S+)$/m)?.[1];
  assert.ok(publicKey && privateKey, 'both keys printed');
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(privateKey, 'base64url').length, 32);
  assert.doesNotThrow(() => webpush.setVapidDetails('mailto:ops@example.com', publicKey, privateKey));
  assert.match(out, /^ {2}VAPID_SUBJECT=mailto:/m);
  assert.notEqual(execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' }), out, 'fresh pair every run');
});

test('stdout only: no file, network or subprocess access in the script', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /node:(fs|http|https|net|child_process)|\bfetch\(/);
});
