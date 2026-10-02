import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import webpush from 'web-push';

const prisma = new PrismaClient();

// lib/push.ts reads VAPID_* once at import, so each config runs in its own process.
// Empty strings (not deletion) so with-branch-schema's .env load can't refill them.
function runWithVapid(vapid: Record<string, string>, extraEnv: Record<string, string> = {}) {
  const appUrl = pathToFileURL(join(import.meta.dirname, '..', 'app.ts')).href;
  const pushUrl = pathToFileURL(join(import.meta.dirname, 'push.ts')).href;
  const script = `
    let unhandled = 0;
    process.on('unhandledRejection', () => { unhandled += 1; });
    const out = {};
    try {
      const { createApp } = await import(${JSON.stringify(appUrl)});
      const { notifyUser } = await import(${JSON.stringify(pushUrl)});
      const server = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
      const base = 'http://127.0.0.1:' + server.address().port;
      const key = await fetch(base + '/api/push/vapid-public-key');
      out.keyStatus = key.status;
      out.publicKey = (await key.json()).publicKey;
      out.subscribeStatus = (await fetch(base + '/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status;
      try { await notifyUser(process.env.NOTIFY_USER_ID || 'no-such-user', { title: 't', body: 'b' }); out.notifyThrew = false; }
      catch { out.notifyThrew = true; }
      await new Promise((r) => setTimeout(r, 50));
      server.close();
      out.booted = true;
    } catch (err) { out.booted = false; out.error = String(err && err.message || err); }
    out.unhandled = unhandled;
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '', ...vapid, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = res.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `child produced no result. stderr:\n${res.stderr}`);
  return { ...JSON.parse(line.slice('RESULT '.length)), stderr: res.stderr } as {
    booted: boolean; error?: string; keyStatus: number; publicKey: string; subscribeStatus: number;
    notifyThrew: boolean; unhandled: number; stderr: string;
  };
}

test('VAPID unset: API boots, public-key route says push is off, notifyUser still records the in-app notification', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (a location) must exist to run this test');
  const user = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__push-test__ vapid-off', systemRole: 'STAFF' },
  });
  try {
    const r = runWithVapid({}, { NOTIFY_USER_ID: user.id });
    assert.equal(r.booted, true, r.error);
    assert.equal(r.keyStatus, 200);
    assert.equal(r.publicKey, '');
    assert.equal(r.subscribeStatus, 401, 'subscribe still requires a session, never 500');
    assert.equal(r.notifyThrew, false);
    assert.equal(r.unhandled, 0);
    assert.match(r.stderr, /push notifications are disabled/);
    assert.equal(await prisma.notification.count({ where: { userId: user.id } }), 1);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('malformed VAPID config (subject without mailto:, bad keys) disables push instead of crashing the API', () => {
  const keys = webpush.generateVAPIDKeys();
  for (const vapid of [
    { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'ops@example.com' },
    { VAPID_PUBLIC_KEY: 'not-a-key', VAPID_PRIVATE_KEY: 'also-not', VAPID_SUBJECT: 'mailto:ops@example.com' },
  ]) {
    const r = runWithVapid(vapid);
    assert.equal(r.booted, true, r.error);
    assert.equal(r.publicKey, '', 'clients must not subscribe with a key the server cannot sign for');
    assert.equal(r.notifyThrew, false);
    assert.equal(r.unhandled, 0);
    assert.match(r.stderr, /push notifications are disabled/);
  }
});

test('only one VAPID key set: public-key route does not hand out a key the server cannot use', () => {
  const keys = webpush.generateVAPIDKeys();
  const r = runWithVapid({ VAPID_PUBLIC_KEY: keys.publicKey });
  assert.equal(r.booted, true, r.error);
  assert.equal(r.publicKey, '');
});

test('valid VAPID config: public key is served; notifyUser never rejects even when the DB is unreachable', () => {
  const keys = webpush.generateVAPIDKeys();
  const vapid = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' };
  assert.equal(runWithVapid(vapid).publicKey, keys.publicKey);

  // Port 1 refuses instantly: notification.create AND the subscription lookup both fail.
  const r = runWithVapid(vapid, { DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x?connect_timeout=2' });
  assert.equal(r.booted, true, r.error);
  assert.equal(r.notifyThrew, false, 'callers fire notifyUser with `void`, so a rejection would crash the process');
  assert.equal(r.unhandled, 0);
});
