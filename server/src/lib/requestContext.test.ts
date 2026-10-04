import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApp } from '../app.js';
import { currentRequestId, installLogContext, maskPhones, requestIdMiddleware } from './requestContext.js';
import { checkReadiness } from './readiness.js';

async function withApp<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('maskPhones: international and long digit runs are masked to their last two digits; dates, times and codes are not', () => {
  assert.equal(maskPhones('OTP for +971501234567 sent'), 'OTP for +••••••••••67 sent');
  assert.equal(maskPhones('+971 50 123 4567'), '+••••••••••67');
  assert.equal(maskPhones('phone 0501234567'), 'phone ••••••••67');
  for (const keep of ['at 2026-10-04T03:10:06.000Z', 'code 123456', 'week 2026-10-05..2026-10-11', 'shift 09:00–17:00']) assert.equal(maskPhones(keep), keep);
});

test('every response carries an X-Request-Id; a safe incoming id is kept, anything else is replaced', async () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/x', async (_req, res) => {
    await new Promise((r) => setTimeout(r, 5)); // the id survives async work
    res.json({ id: currentRequestId() });
  });
  await withApp(app, async (base) => {
    const fresh = await fetch(`${base}/x`);
    const id = fresh.headers.get('x-request-id');
    assert.match(id ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(((await fresh.json()) as { id: string }).id, id);
    const kept = await fetch(`${base}/x`, { headers: { 'X-Request-Id': 'edge-abc12345' } });
    assert.equal(kept.headers.get('x-request-id'), 'edge-abc12345');
    const replaced = await fetch(`${base}/x`, { headers: { 'X-Request-Id': 'bad id with spaces <script>' } });
    assert.match(replaced.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });
  assert.equal(currentRequestId(), undefined, 'no id outside a request');
});

test('installLogContext: lines written during a request get [rid=…], and phones are masked in strings and errors', async () => {
  const lines: string[] = [];
  const fake = {
    log: (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
    info: (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
    warn: (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void lines.push(a.map(String).join(' ')),
  };
  installLogContext(fake);
  installLogContext(fake); // idempotent: no double prefix
  fake.log('outside +971501234567');
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/x', (_req, res) => {
    fake.error('[x] failed', new Error('Invalid value for phone: +971501234567'));
    res.end();
  });
  await withApp(app, async (base) => {
    const res = await fetch(`${base}/x`, { headers: { 'X-Request-Id': 'abcdef0123456789' } });
    await res.text();
  });
  assert.equal(lines[0], 'outside +••••••••••67');
  assert.match(lines[1]!, /^\[rid=abcdef01\] \[x\] failed Error: Invalid value for phone: \+••••••••••67/);
  assert.ok(!lines.join('\n').includes('501234567'));
});

test('GET /api/health/ready: database reachable and every shipped migration applied → 200 with counts only', async () => {
  await withApp(createApp(), async (base) => {
    const res = await fetch(`${base}/api/health/ready`);
    const body = (await res.json()) as { ok: boolean; db: string; migrations: { expected: number; applied: number; pending: number } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.db, 'ok');
    assert.equal(body.migrations.pending, 0);
    assert.equal(body.migrations.expected, readdirSync('prisma/migrations', { withFileTypes: true }).filter((d) => d.isDirectory()).length);
    assert.ok(res.headers.get('x-request-id'));
    const live = await fetch(`${base}/api/health`);
    assert.deepEqual(await live.json(), { ok: true }, '/api/health is unchanged');
  });
});

test('readiness: a migration folder that was never applied → not ready (503 shape); a dead or hanging database → unreachable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  try {
    for (const d of readdirSync('prisma/migrations', { withFileTypes: true }).filter((e) => e.isDirectory())) {
      mkdirSync(join(dir, d.name));
      writeFileSync(join(dir, d.name, 'migration.sql'), '-- copy');
    }
    mkdirSync(join(dir, '29991231000000_never_applied'));
    writeFileSync(join(dir, '29991231000000_never_applied', 'migration.sql'), '-- pending');
    const pending = await checkReadiness(undefined, dir);
    assert.deepEqual([pending.ok, pending.db, pending.migrations?.pending], [false, 'ok', 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const savedError = console.error;
  console.error = () => {};
  try {
    const dead = await checkReadiness({ $queryRaw: (() => Promise.reject(new Error('connection refused'))) as never });
    assert.deepEqual(dead, { ok: false, db: 'unreachable', migrations: null });
    const hanging = await checkReadiness({ $queryRaw: (() => new Promise(() => {})) as never }, undefined, 50);
    assert.equal(hanging.db, 'unreachable');
  } finally {
    console.error = savedError;
  }
});
