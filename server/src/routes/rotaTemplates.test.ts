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

// 2026-09-05 — closes a real, pre-existing gap the withAuditedTransaction
// review found: POST /, DELETE /:id, and POST /:id/apply were all
// requireSession-only, so any authenticated STAFF session could create or
// delete templates, or — most severe — bulk-create a full week of real
// Shift rows for the whole venue via /:id/apply, no UI needed. No test file
// existed for this router at all before this fix.
test('rotaTemplates.ts mutation routes reject a real STAFF session with 403 — POST /, DELETE /:id, POST /:id/apply', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ rotaTemplates requireManager', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: location.id, name: '__authgap-test__ role' } });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ manager', systemRole: 'MANAGER' },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ staff', systemRole: 'STAFF' },
  });
  const template = await prisma.rotaTemplate.create({
    data: {
      locationId: location.id,
      name: '__authgap-test__ template',
      entries: [{ dayOffset: 0, roleId: role.id, userId: null, start: '09:00', end: '17:00' }],
      createdById: manager.id,
    },
  });

  try {
    const staffToken = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` };

      const post = await fetch(`${baseUrl}/api/rota-templates`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: '__authgap-test__ staff-attempted', entries: [{ dayOffset: 0, roleId: role.id, userId: null, start: '09:00', end: '17:00' }] }),
      });
      assert.equal(post.status, 403, 'POST / must reject a STAFF session');

      const del = await fetch(`${baseUrl}/api/rota-templates/${template.id}`, { method: 'DELETE', headers });
      assert.equal(del.status, 403, 'DELETE /:id must reject a STAFF session');

      const apply = await fetch(`${baseUrl}/api/rota-templates/${template.id}/apply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ weekStart: '2031-04-07' }),
      });
      assert.equal(apply.status, 403, 'POST /:id/apply must reject a STAFF session');
    });

    // Nothing any of the rejected calls attempted should have actually landed.
    const templates = await prisma.rotaTemplate.findMany({ where: { locationId: location.id } });
    assert.equal(templates.length, 1, 'only the original template should exist — no STAFF mutation attempt should have succeeded');
    assert.equal(templates[0]!.id, template.id);

    const shifts = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(shifts.length, 0, 'the rejected apply must not have created any shifts');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.rotaTemplate.deleteMany({ where: { locationId: location.id } });
    await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staff.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// Companion to the STAFF-403 test: proves adding requireManager didn't also
// break the legitimate case.
test('rotaTemplates.ts mutation routes still work normally for a real MANAGER session — POST /, DELETE /:id, POST /:id/apply', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ rotaTemplates still works', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: location.id, name: '__authgap-test__ works role' } });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ works manager', systemRole: 'MANAGER' },
  });
  const weekStart = '2031-06-02'; // a Monday, isolated from other tests' fixture dates

  try {
    const token = await sessionFor(manager.id);
    let templateId = '';
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      const post = await fetch(`${baseUrl}/api/rota-templates`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: '__authgap-test__ works template', entries: [{ dayOffset: 0, roleId: role.id, userId: null, start: '09:00', end: '17:00' }] }),
      });
      assert.equal(post.status, 201, 'a real manager session must still be able to create a template');
      const postBody = (await post.json()) as { template: { id: string } };
      templateId = postBody.template.id;

      const apply = await fetch(`${baseUrl}/api/rota-templates/${templateId}/apply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ weekStart }),
      });
      assert.equal(apply.status, 201, 'a real manager session must still be able to apply a template');
      const applyBody = (await apply.json()) as { createdCount: number };
      assert.equal(applyBody.createdCount, 1);

      const del = await fetch(`${baseUrl}/api/rota-templates/${templateId}`, { method: 'DELETE', headers });
      assert.equal(del.status, 204, 'a real manager session must still be able to delete a template');
    });

    const shifts = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(shifts.length, 1, 'the applied template must have created exactly one real shift');
    const templates = await prisma.rotaTemplate.findMany({ where: { locationId: location.id } });
    assert.equal(templates.length, 0, 'the template must have actually been deleted');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.rotaTemplate.deleteMany({ where: { locationId: location.id } });
    await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
