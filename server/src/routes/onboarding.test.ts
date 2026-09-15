import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

const prisma = new PrismaClient();

/** Starts the real Express app on an ephemeral port and hands the caller its base URL. */
async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp();
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

/** Issues a real bearer session token for a real User, exactly like a login would. */
async function sessionFor(userId: string): Promise<string> {
  const { plainToken } = await issueSession(userId);
  return plainToken;
}

test("GET /api/onboarding/:locationId/invite builds the invite link from the caller-supplied frontend origin, not the API server's own host", async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: '__onboarding-test__ invite-origin',
      timezone: 'Asia/Dubai',
    },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__onboarding-test__ Manager', systemRole: 'MANAGER' },
  });

  try {
    await withServer(async (apiBaseUrl) => {
      const token = await sessionFor(manager.id);
      // The frontend origin the real client (`src/api/onboarding.ts`) now
      // sends as `?baseUrl=`, deliberately a different host:port than the
      // API server under test here — a regression back to defaulting on
      // `req.protocol://req.get('host')` (the bug: every invite
      // link/QR/WhatsApp text pointed at the backend API port instead of the
      // app, 404ing for anyone who opened it) would fail these assertions.
      const frontendOrigin = 'http://localhost:5175';
      const res = await fetch(`${apiBaseUrl}/api/onboarding/${location.id}/invite?baseUrl=${encodeURIComponent(frontendOrigin)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { inviteUrl: string; qrDataUrl: string; whatsappUrl: string };

      assert.equal(body.inviteUrl, `${frontendOrigin}/join?location=${location.id}`);
      assert.ok(!body.inviteUrl.startsWith(apiBaseUrl), "invite link must not point at the API server's own origin");
      assert.ok(body.whatsappUrl.includes(encodeURIComponent(body.inviteUrl)), 'the WhatsApp share text must carry the same frontend-origin link');
      assert.ok(body.qrDataUrl.startsWith('data:image/'), 'QR code must be a real inline data URL');
    });
  } finally {
    await prisma.user.deleteMany({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.deleteMany({ where: { id: location.id } }).catch(() => {});
    assert.equal(await prisma.user.count({ where: { id: manager.id } }), 0);
    assert.equal(await prisma.location.count({ where: { id: location.id } }), 0);
  }
});
