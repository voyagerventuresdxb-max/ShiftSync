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

/** Creates a throwaway Location + MANAGER for one test, and tears both down afterward. */
async function withOnboardingTestManager<T>(nameSuffix: string, fn: (location: { id: string }, manager: { id: string }) => Promise<T>): Promise<T> {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: `__onboarding-test__ ${nameSuffix}`,
      timezone: 'Asia/Dubai',
    },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__onboarding-test__ Manager', systemRole: 'MANAGER' },
  });

  try {
    return await fn(location, manager);
  } finally {
    await prisma.user.deleteMany({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.deleteMany({ where: { id: location.id } }).catch(() => {});
    assert.equal(await prisma.user.count({ where: { id: manager.id } }), 0);
    assert.equal(await prisma.location.count({ where: { id: location.id } }), 0);
  }
}

test("GET /api/onboarding/:locationId/invite builds the invite link from the caller-supplied frontend origin when it's on the server's allowlist", async () => {
  await withOnboardingTestManager('invite-origin-allowlisted', async (location, manager) => {
    await withServer(async (apiBaseUrl) => {
      const token = await sessionFor(manager.id);
      // The frontend origin the real client (`src/api/onboarding.ts`) sends
      // as `?baseUrl=`, deliberately a different host:port than the API
      // server under test here — a regression back to defaulting on
      // `req.protocol://req.get('host')` (the bug: every invite
      // link/QR/WhatsApp text pointed at the backend API port instead of the
      // app, 404ing for anyone who opened it) would fail these assertions.
      // FRONTEND_ORIGIN must list it for the server to honor it (see the
      // allowlist test below) — this is that allowlisted case.
      const frontendOrigin = 'http://localhost:5175';
      const previousEnv = process.env.FRONTEND_ORIGIN;
      process.env.FRONTEND_ORIGIN = frontendOrigin;
      try {
        const res = await fetch(`${apiBaseUrl}/api/onboarding/${location.id}/invite?baseUrl=${encodeURIComponent(frontendOrigin)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { inviteUrl: string; qrDataUrl: string; whatsappUrl: string };

        assert.equal(body.inviteUrl, `${frontendOrigin}/join?location=${location.id}`);
        assert.ok(!body.inviteUrl.startsWith(apiBaseUrl), "invite link must not point at the API server's own origin");
        assert.ok(body.whatsappUrl.includes(encodeURIComponent(body.inviteUrl)), 'the WhatsApp share text must carry the same frontend-origin link');
        assert.ok(body.qrDataUrl.startsWith('data:image/'), 'QR code must be a real inline data URL');
      } finally {
        if (previousEnv === undefined) delete process.env.FRONTEND_ORIGIN;
        else process.env.FRONTEND_ORIGIN = previousEnv;
      }
    });
  });
});

test('GET /api/onboarding/:locationId/invite ignores a client-supplied baseUrl that is not on the server allowlist, falling back to the configured FRONTEND_ORIGIN', async () => {
  await withOnboardingTestManager('invite-origin-forged', async (location, manager) => {
    await withServer(async (apiBaseUrl) => {
      const token = await sessionFor(manager.id);
      const trustedOrigin = 'http://localhost:5173';
      const attackerOrigin = 'https://attacker-controlled.example.com';
      const previousEnv = process.env.FRONTEND_ORIGIN;
      process.env.FRONTEND_ORIGIN = trustedOrigin;
      try {
        // A compromised/forged client sends an off-allowlist origin — the
        // server must never mint a QR/WhatsApp invite pointing at it.
        const res = await fetch(`${apiBaseUrl}/api/onboarding/${location.id}/invite?baseUrl=${encodeURIComponent(attackerOrigin)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { inviteUrl: string; whatsappUrl: string };

        assert.equal(body.inviteUrl, `${trustedOrigin}/join?location=${location.id}`);
        assert.ok(!body.inviteUrl.startsWith(attackerOrigin), 'invite link must never point at an unlisted, client-supplied origin');
        assert.ok(!body.whatsappUrl.includes(encodeURIComponent(attackerOrigin)), 'WhatsApp share text must never carry the unlisted origin');
      } finally {
        if (previousEnv === undefined) delete process.env.FRONTEND_ORIGIN;
        else process.env.FRONTEND_ORIGIN = previousEnv;
      }
    });
  });
});

test('GET /api/onboarding/:locationId/invite falls back to the default frontend origin when the client supplies no baseUrl and FRONTEND_ORIGIN is unset', async () => {
  await withOnboardingTestManager('invite-origin-default', async (location, manager) => {
    await withServer(async (apiBaseUrl) => {
      const token = await sessionFor(manager.id);
      const previousEnv = process.env.FRONTEND_ORIGIN;
      delete process.env.FRONTEND_ORIGIN;
      try {
        const res = await fetch(`${apiBaseUrl}/api/onboarding/${location.id}/invite`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { inviteUrl: string };

        // Must never fall back to the API server's own host/port.
        assert.equal(body.inviteUrl, `http://localhost:5173/join?location=${location.id}`);
        assert.ok(!body.inviteUrl.startsWith(apiBaseUrl), "invite link must not default to the API server's own origin");
      } finally {
        if (previousEnv === undefined) delete process.env.FRONTEND_ORIGIN;
        else process.env.FRONTEND_ORIGIN = previousEnv;
      }
    });
  });
});
