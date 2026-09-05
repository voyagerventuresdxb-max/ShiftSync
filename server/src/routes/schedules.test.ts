import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { uploadCache } from '../store/uploadCache.js';
import type { PreviewRow } from '../parsing/types.js';

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

function fakeRow(overrides: Partial<PreviewRow>): PreviewRow {
  return {
    rowNumber: 1,
    employeeName: '__authgap-test__ employee',
    roleName: 'Waiter',
    date: '2031-04-07',
    startTime: '09:00',
    endTime: '17:00',
    overnight: false,
    breakMinutes: 0,
    managerNotes: null,
    status: 'matched',
    resolvedRoleId: null,
    resolvedUserId: null,
    issues: [],
    ...overrides,
  };
}

// 2026-09-05 — closes a real, pre-existing gap the withAuditedTransaction
// review found: POST /upload/:batchId/confirm was requireSession-only, so
// any authenticated STAFF session could confirm a batch (including one
// uploaded by someone else at the same venue, since ownedOrNotFound only
// checks venue, not uploader) and bulk-create real Shift rows for the whole
// venue. No test file existed for this router at all before this fix.
test('schedules.ts POST /upload/:batchId/confirm rejects a real STAFF session with 403 — nothing persists', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ schedules requireManager', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: location.id, name: '__authgap-test__ role' } });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ staff', systemRole: 'STAFF' },
  });
  const batchId = uploadCache.put(location.id, null, [fakeRow({ resolvedRoleId: role.id })]);

  try {
    const staffToken = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` };
      const confirm = await fetch(`${baseUrl}/api/schedules/upload/${batchId}/confirm`, { method: 'POST', headers, body: JSON.stringify({}) });
      assert.equal(confirm.status, 403, 'POST /upload/:batchId/confirm must reject a STAFF session');
    });

    const shifts = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(shifts.length, 0, 'the rejected confirm must not have created any shifts');
  } finally {
    uploadCache.delete(batchId);
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staff.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// Companion to the STAFF-403 test: proves adding requireManager didn't also
// break the legitimate case.
test('schedules.ts POST /upload/:batchId/confirm still works normally for a real MANAGER session', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ schedules still works', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: location.id, name: '__authgap-test__ works role' } });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ works manager', systemRole: 'MANAGER' },
  });
  const batchId = uploadCache.put(location.id, null, [fakeRow({ resolvedRoleId: role.id })]);

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const confirm = await fetch(`${baseUrl}/api/schedules/upload/${batchId}/confirm`, { method: 'POST', headers, body: JSON.stringify({}) });
      assert.equal(confirm.status, 201, 'a real manager session must still be able to confirm an upload batch');
      const body = (await confirm.json()) as { createdCount: number };
      assert.equal(body.createdCount, 1);
    });

    const shifts = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(shifts.length, 1, 'the confirmed batch must have created exactly one real shift');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// 2026-09-05 — found by the mandatory review of the requireManager diff
// above: buildEntry used to unconditionally write a SHIFT_CREATED audit row
// even when persistShifts created zero shifts (every row skipped for an
// unresolved role), pointing at the batchId instead of a real Shift id — a
// false compliance-audit entry. Fixed to only write when createdCount > 0,
// matching floorPlan.ts's publish route's identical guard.
test('schedules.ts POST /upload/:batchId/confirm does not write a false audit-log entry when every row is skipped (no resolvable role)', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ schedules no-op audit', timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ no-op manager', systemRole: 'MANAGER' },
  });
  // resolvedRoleId: null -> persistShifts skips this row entirely (no valid Shift.roleId FK to satisfy).
  const batchId = uploadCache.put(location.id, null, [fakeRow({ resolvedRoleId: null })]);

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const confirm = await fetch(`${baseUrl}/api/schedules/upload/${batchId}/confirm`, { method: 'POST', headers, body: JSON.stringify({}) });
      assert.equal(confirm.status, 201);
      const body = (await confirm.json()) as { createdCount: number; skippedCount: number };
      assert.equal(body.createdCount, 0);
      assert.equal(body.skippedCount, 1);
    });

    const shifts = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(shifts.length, 0, 'no shift should have been created');
    const auditLogs = await prisma.auditLog.findMany({ where: { locationId: location.id, action: 'SHIFT_CREATED' } });
    assert.equal(auditLogs.length, 0, 'no audit-log row should be written when nothing was actually created');
  } finally {
    await prisma.auditLog.deleteMany({ where: { locationId: location.id } });
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
