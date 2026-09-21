import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { uploadCache } from '../store/uploadCache.js';
import type { PreviewRow } from '../parsing/types.js';
import { canonicalRoleName } from '../parsing/resolveRows.js';

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

// Regression: the edit-resolution loop used to run each row's role
// lookup-then-maybe-create inside `Promise.all(rows.map(async ...))`.
// `Array.prototype.map` invokes every callback synchronously up to its
// first `await`, so two rows editing to the SAME brand-new role name both
// read the in-memory roleByName map as a miss before either
// `prisma.role.create` resolved — both issued a create, the second threw an
// unhandled P2002 (Role has `@@unique([locationId, name])`), and the whole
// confirm 500'd, discarding every row's edits in the batch, not just the
// colliding two. Fixed by resolving/creating every distinct new role name
// SEQUENTIALLY, before the (now synchronous) row-mapping loop runs at all.
test('schedules.ts POST /upload/:batchId/confirm: two edited rows picking the same brand-new role name both succeed, creating exactly one Role (not a 500)', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ schedules role race', timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ role-race manager', systemRole: 'MANAGER' },
  });
  const batchId = uploadCache.put(location.id, null, [
    fakeRow({ rowNumber: 1, employeeName: '__authgap-test__ employee one', resolvedRoleId: null }),
    fakeRow({ rowNumber: 2, employeeName: '__authgap-test__ employee two', resolvedRoleId: null }),
  ]);
  const newRoleName = '__authgap-test__ Sommelier';

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const confirm = await fetch(`${baseUrl}/api/schedules/upload/${batchId}/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          edits: [
            { rowNumber: 1, role: newRoleName },
            { rowNumber: 2, role: newRoleName },
          ],
        }),
      });
      assert.equal(confirm.status, 201, 'two rows racing to create the same brand-new role must not 500 the whole confirm');
      const body = (await confirm.json()) as { createdCount: number; skippedCount: number };
      assert.equal(body.createdCount, 2, 'both rows must have resolved and been created, not just one');
      assert.equal(body.skippedCount, 0);
    });

    const shifts = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(shifts.length, 2, 'both edited rows must have persisted as real shifts');

    const roles = await prisma.role.findMany({ where: { locationId: location.id, name: newRoleName } });
    assert.equal(roles.length, 1, 'exactly one Role must exist for the shared new name — no duplicate/orphaned row from the race');
    assert.ok(shifts.every((s) => s.roleId === roles[0]!.id), 'both shifts must reference the same, single created Role');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.role.deleteMany({ where: { locationId: location.id, name: newRoleName } });
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// Issue #12 (PR #11 follow-up review): the brand-new-role auto-create above
// used to `prisma.role.create({ data: { name: trimmed } })` — the RAW chip
// label a manager typed/picked, not its canonicalized form. Picking a chip
// literally labeled "Manager" created a Role literally named "Manager"
// instead of the canonical "Management" that resolveRows.ts's own
// alias-lookup (canonicalRoleName) already produces for every other path.
// Fixed by canonicalizing before the create, matching resolveRows.ts.
test('schedules.ts POST /upload/:batchId/confirm: a brand-new role picked via an alias chip ("Manager") is created under its canonical name ("Management")', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  assert.equal(canonicalRoleName('Manager'), 'Management', 'test assumes the ROLE_ALIASES table maps bare "Manager" to "Management"');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ schedules role canonicalize', timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ canon manager', systemRole: 'MANAGER' },
  });
  const batchId = uploadCache.put(location.id, null, [
    fakeRow({ rowNumber: 1, employeeName: '__authgap-test__ canon employee', resolvedRoleId: null }),
  ]);

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const confirm = await fetch(`${baseUrl}/api/schedules/upload/${batchId}/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ edits: [{ rowNumber: 1, role: 'Manager' }] }),
      });
      assert.equal(confirm.status, 201);
      const body = (await confirm.json()) as { createdCount: number };
      assert.equal(body.createdCount, 1);
    });

    const literalRole = await prisma.role.findFirst({ where: { locationId: location.id, name: 'Manager' } });
    assert.equal(literalRole, null, 'must not have created a Role literally named "Manager"');

    const canonicalRole = await prisma.role.findFirst({ where: { locationId: location.id, name: 'Management' } });
    assert.ok(canonicalRole, 'must have created the Role under its canonical name "Management"');

    const shifts = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(shifts.length, 1);
    assert.equal(shifts[0]!.roleId, canonicalRole!.id, 'the created shift must reference the canonically-named Role');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.role.deleteMany({ where: { locationId: location.id } });
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// Issue #13 (PR #11 follow-up review): the edit-resolution role lookup used
// to `prisma.role.findMany({ where: { locationId } })` with no `isActive`
// filter — unlike GET /api/roles, which correctly scopes to `isActive: true`
// (the set a manager can actually pick a chip from). A deactivated Role
// could silently be matched and reused here (with status: matched and no
// warning) even though it could never have been selected as a chip. Fixed by
// adding the same isActive: true filter — and since a deactivated Role still
// occupies its name under `@@unique([locationId, name])`, a create for that
// same name would otherwise 500; the fix reactivates the existing row
// instead (same Role id, isActive flipped back to true) rather than
// silently matching it as-is or crashing the whole confirm.
test('schedules.ts POST /upload/:batchId/confirm: an edit naming a deactivated role reactivates it instead of silently matching it, or creating a colliding duplicate', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ schedules role isActive', timezone: 'Asia/Dubai' },
  });
  const inactiveRoleName = '__authgap-test__ Retired Role';
  const inactiveRole = await prisma.role.create({
    data: { locationId: location.id, name: inactiveRoleName, isActive: false },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ isActive manager', systemRole: 'MANAGER' },
  });
  const batchId = uploadCache.put(location.id, null, [
    fakeRow({ rowNumber: 1, employeeName: '__authgap-test__ isActive employee', resolvedRoleId: null }),
  ]);

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const confirm = await fetch(`${baseUrl}/api/schedules/upload/${batchId}/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ edits: [{ rowNumber: 1, role: inactiveRoleName }] }),
      });
      assert.equal(confirm.status, 201);
      const body = (await confirm.json()) as { createdCount: number };
      assert.equal(body.createdCount, 1);
    });

    const shifts = await prisma.shift.findMany({ where: { locationId: location.id } });
    assert.equal(shifts.length, 1);

    const rolesByName = await prisma.role.findMany({ where: { locationId: location.id, name: inactiveRoleName } });
    assert.equal(rolesByName.length, 1, 'must not have created a second, colliding Role row for the same name');
    assert.equal(rolesByName[0]!.id, inactiveRole.id, 'the existing Role row must have been reactivated, not replaced');
    assert.equal(rolesByName[0]!.isActive, true, 'the previously-deactivated Role must now be active again');
    assert.equal(shifts[0]!.roleId, inactiveRole.id, 'the created shift must reference the (now-reactivated) Role');
  } finally {
    await prisma.shift.deleteMany({ where: { locationId: location.id } });
    await prisma.role.deleteMany({ where: { locationId: location.id } });
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// --- xlsx -> exceljs migration (Issue #23): upload-path behavior that changed ---

/** A real MANAGER session at a throwaway venue, plus the cleanup for it. */
async function uploadFixture(name: string) {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: `__upload-test__ ${name}`, timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: `__upload-test__ ${name} manager`, systemRole: 'MANAGER' },
  });
  const token = await sessionFor(manager.id);
  return {
    token,
    cleanup: async () => {
      await prisma.user.deleteMany({ where: { locationId: location.id } });
      await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
    },
  };
}

async function postUpload(baseUrl: string, token: string, filename: string, bytes: Buffer, mimetype: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimetype }), filename);
  return fetch(`${baseUrl}/api/schedules/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

// exceljs cannot read legacy binary .xls (SheetJS could). Before this route
// change the unreadable-file error was thrown a second time from INSIDE the
// catch that handled the first, escaping to the generic handler as a 500 —
// so the uploader would never have seen why. Every .xls upload is now that case.
test('schedules.ts POST /upload: a legacy .xls is refused with a 422 and an actionable message, not a generic 500', async () => {
  const { token, cleanup } = await uploadFixture('legacy-xls');
  try {
    await withServer(async (baseUrl) => {
      const ole2 = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]);
      const res = await postUpload(baseUrl, token, 'roster.xls', ole2, 'application/vnd.ms-excel');
      assert.equal(res.status, 422);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /roster\.xls/);
      assert.match(body.error, /legacy Excel/);
      assert.match(body.error, /Save As/);
    });
  } finally {
    await cleanup();
  }
});

// Windows browsers label a plain .csv `application/vnd.ms-excel`, so the
// format is sniffed from the bytes, not the mimetype. And SheetJS's CSV
// reader turned every "9-17" cell into a Date, so a normal CSV roster could
// never have parsed; exceljs keeps it text.
test('schedules.ts POST /upload: a semicolon-separated CSV roster (mislabelled application/vnd.ms-excel) with "9-17" shifts parses into real shifts', async () => {
  const { token, cleanup } = await uploadFixture('csv-roster');
  try {
    await withServer(async (baseUrl) => {
      const csv = ['Name;2026-08-17;2026-08-18', 'Fatima;9-17;10-18'].join('\n') + '\n';
      const res = await postUpload(baseUrl, token, 'roster.csv', Buffer.from(csv, 'utf8'), 'application/vnd.ms-excel');
      assert.equal(res.status, 200, await res.clone().text());
      const body = (await res.json()) as { preview: { employeeName: string; date: string; startTime: string; endTime: string }[] };
      const shifts = body.preview.map((r) => `${r.employeeName}|${r.date}|${r.startTime}-${r.endTime}`).sort();
      assert.deepEqual(shifts, ['Fatima|2026-08-17|09:00-17:00', 'Fatima|2026-08-18|10:00-18:00']);
    });
  } finally {
    await cleanup();
  }
});
