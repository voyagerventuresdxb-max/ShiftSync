import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../app.js';
import { issueSession } from '../identity.js';
import { applyRotaTemplate } from './rotaActions.js';

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

// Finding #1 from the whole-branch review of this slice: voice.ts's
// APPLY_ROTA_TEMPLATE execute case called applyRotaTemplate directly with no
// location-ownership check on the resolved templateId, unlike every other
// case in that same switch (CREATE_SHIFT's role/staff, EDIT_SHIFT's shift,
// ASSIGN_SECTION's section) and unlike rotaTemplates.ts's own REST route for
// the identical action. /parse-intent's own template candidate list is
// scoped to the caller's locationId, but that's enforcement by the model,
// not a structural guarantee — /execute accepts a raw intent directly (see
// routes/voice.ts's own "THIS IS THE ONLY REAL SECURITY BOUNDARY" comment),
// so a hand-crafted request naming another venue's templateId would have
// applied that venue's template and created real Shift rows there, under
// the calling manager's own actorId.
test('POST /api/voice/execute: APPLY_ROTA_TEMPLATE rejects a template that belongs to a different location — 404, nothing created, no audit row', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__rotaActions-test__ other venue (cross-loc template)', timezone: 'Asia/Dubai' },
  });
  const otherRole = await prisma.role.create({ data: { locationId: otherLocation.id, name: '__rotaActions-test__ cross-loc role' } });
  const otherTemplate = await prisma.rotaTemplate.create({
    data: {
      locationId: otherLocation.id,
      name: '__rotaActions-test__ other venue template',
      entries: [{ dayOffset: 0, roleId: otherRole.id, userId: null, start: '09:00', end: '17:00' }],
    },
  });

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__rotaActions-test__ cross-loc manager (own location)', systemRole: 'MANAGER' },
  });

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/voice/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: 'apply the other venue template',
          intent: {
            intent: 'APPLY_ROTA_TEMPLATE',
            templateId: otherTemplate.id,
            templateName: otherTemplate.name,
            weekStart: '2026-09-21',
            summary: 'Apply template.',
          },
        }),
      });
      assert.equal(res.status, 404, 'a manager must not be able to apply a template from a different location');
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /not found/i);
    });

    const createdShifts = await prisma.shift.count({
      where: { locationId: otherLocation.id, date: { gte: new Date('2026-09-21T00:00:00.000Z'), lt: new Date('2026-09-28T00:00:00.000Z') } },
    });
    assert.equal(createdShifts, 0, 'no Shift rows may be created in the other venue from a rejected cross-location apply');

    const auditRows = await prisma.auditLog.count({
      where: { entityType: 'Shift', action: 'SHIFT_CREATED', note: { contains: otherTemplate.name } },
    });
    assert.equal(auditRows, 0, 'no AuditLog row may exist for a cross-location apply that was rejected');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: otherLocation.id } });
    await prisma.auditLog.deleteMany({ where: { note: { contains: '__rotaActions-test__' } } });
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.rotaTemplate.delete({ where: { id: otherTemplate.id } }).catch(() => {});
    await prisma.role.delete({ where: { id: otherRole.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

// Finding #2 from the same review: applyRotaTemplate's buildEntry always
// returned an audit entry, unlike the identical `count > 0 ? {...} : null`
// guard schedules.ts's confirm route and floorPlan.ts's publish route
// already use for this exact shape of no-op. POST /api/rota-templates
// already rejects an empty `entries` array at creation time, so this is
// unreachable through the normal route — exercised here via a template
// written directly to the DB (bypassing that route-level guard), the same
// way a future second write path or a stale/corrupted row could reach it.
test('applyRotaTemplate writes no AuditLog row when the guard would produce zero created shifts', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__rotaActions-test__ zero-entries manager', systemRole: 'MANAGER' },
  });
  const emptyTemplate = await prisma.rotaTemplate.create({
    data: { locationId: location!.id, name: '__rotaActions-test__ zero-entries template', entries: [] },
  });

  try {
    const result = await applyRotaTemplate({
      templateId: emptyTemplate.id,
      weekStart: new Date('2026-09-21T00:00:00.000Z'),
      createdById: manager.id,
      actorId: manager.id,
    });
    assert.equal(result.result, 'ok');
    assert.equal(result.result === 'ok' && result.createdCount, 0, 'a zero-entry template must create zero shifts');

    const auditRows = await prisma.auditLog.count({
      where: { entityType: 'Shift', action: 'SHIFT_CREATED', note: { contains: emptyTemplate.name } },
    });
    assert.equal(auditRows, 0, 'no AuditLog row may be written for an apply that created zero shifts');
  } finally {
    await prisma.rotaTemplate.delete({ where: { id: emptyTemplate.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
  }
});
