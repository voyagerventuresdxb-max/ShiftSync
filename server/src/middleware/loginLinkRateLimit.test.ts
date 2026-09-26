import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { requireSession } from './requireSession.js';
import { loginLinkIssueRateLimiter, loginLinkPeekRateLimiter, loginLinkRedeemRateLimiter } from './rateLimit.js';
import { issueSession } from '../lib/identity.js';

/**
 * The real limiter singletons routes/loginLinks.ts mounts, in front of a
 * dummy handler (same approach as otpRateLimit.test.ts): proves the keys and
 * thresholds without minting hundreds of real links.
 */
const prisma = new PrismaClient();

async function withServer<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('issuing is limited to 10 per hour per SESSION; another session is unaffected', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist');
  const a = await prisma.user.create({ data: { locationId: location!.id, fullName: '__loginlink-rl__ A', systemRole: 'MANAGER' } });
  const b = await prisma.user.create({ data: { locationId: location!.id, fullName: '__loginlink-rl__ B', systemRole: 'MANAGER' } });
  try {
    const tokenA = (await issueSession(a.id)).plainToken;
    const tokenB = (await issueSession(b.id)).plainToken;
    const app = express();
    app.use(express.json());
    app.post('/issue', requireSession, loginLinkIssueRateLimiter, (_req, res) => res.status(201).json({ ok: true }));
    await withServer(app, async (baseUrl) => {
      const post = (token: string) => fetch(`${baseUrl}/issue`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      for (let i = 0; i < 10; i++) assert.equal((await post(tokenA)).status, 201, `issue #${i + 1} is within the allowance`);
      const limited = await post(tokenA);
      assert.equal(limited.status, 429);
      assert.match(((await limited.json()) as { error: string }).error, /too many/i);
      assert.equal((await post(tokenB)).status, 201, "another manager's session has its own bucket");
    });
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await prisma.$disconnect();
  }
});

test('redeem is 30 per 10 minutes per IP and peek has its own 60 — a sign-in (one peek + one redeem) never halves capacity', async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/peek', loginLinkPeekRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
  app.post('/redeem', loginLinkRedeemRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
  await withServer(app, async (baseUrl) => {
    const post = (path: string, ip: string) =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: '{"token":"x"}' });
    for (let i = 0; i < 30; i++) {
      assert.equal((await post('/peek', '10.9.9.1')).status, 200, `peek #${i + 1} allowed`);
      assert.equal((await post('/redeem', '10.9.9.1')).status, 200, `redeem #${i + 1} allowed`);
    }
    assert.equal((await post('/redeem', '10.9.9.1')).status, 429, 'the 31st redeem from one IP is limited');
    assert.equal((await post('/peek', '10.9.9.1')).status, 200, 'peek has its own, larger bucket');
    for (let i = 31; i < 60; i++) assert.equal((await post('/peek', '10.9.9.1')).status, 200, `peek #${i + 1} allowed`);
    assert.equal((await post('/peek', '10.9.9.1')).status, 429, 'the 61st peek from one IP is limited');
    assert.equal((await post('/redeem', '10.9.9.2')).status, 200, 'a different IP is unaffected');
  });
});
