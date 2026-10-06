import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { Router } from 'express';
import { createApp } from '../app.js';
import { listRoutes } from './routeTable.js';

let server: Server;
let base = '';

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test('every API response: nosniff, no referrer, not frameable, and no X-Powered-By banner', async () => {
  for (const path of ['/api/health', '/api/identity/config', '/api/does-not-exist', '/uploads/anything']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(res.headers.get('x-powered-by'), null, path);
  }
});

test('anything sent with a session or a kiosk token is marked no-store; public reads are not', async () => {
  const withSession = await fetch(`${base}/api/ai/usage`, { headers: { Authorization: 'Bearer not-a-real-session' } });
  assert.equal(withSession.status, 401);
  assert.equal(withSession.headers.get('cache-control'), 'no-store');
  const withKiosk = await fetch(`${base}/api/announcements/not-a-venue`, { headers: { 'X-Kiosk-Token': 'not-a-real-token' } });
  assert.equal(withKiosk.headers.get('cache-control'), 'no-store');
  const file = await fetch(`${base}/uploads/policy-documents/00000000-0000-0000-0000-000000000000.pdf`, { headers: { Authorization: 'Bearer x' } });
  assert.equal(file.headers.get('cache-control'), 'no-store');
  const open = await fetch(`${base}/api/health`);
  assert.notEqual(open.headers.get('cache-control'), 'no-store');
});

test('an unknown API path answers JSON 404, not an HTML page', async () => {
  const res = await fetch(`${base}/api/no-such-route`, { method: 'POST' });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), { error: 'Not found.' });
});

test('listRoutes reads the live router: multi-line, double-quoted and nested mounts all count', () => {
  const app = express();
  const r = Router();
  r.get(
    "/multi-line/:id",
    (_req, res) => res.end(),
  );
  r.post('/', (_req, res) => res.end());
  app.use('/api/thing', r);
  app.get('/api/direct', (_req, res) => res.end());
  assert.deepEqual(listRoutes(app), ['GET /api/direct', 'GET /api/thing/multi-line/:id', 'POST /api/thing']);
});
