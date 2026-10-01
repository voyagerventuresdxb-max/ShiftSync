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

/**
 * Builds a throwaway location with its own floor plan image, one section and
 * one staff member. Everything created here cascades off the location row, so
 * `prisma.location.delete` is the only cleanup each test needs.
 */
async function createFixture(nameSuffix: string) {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: {
      organizationId: seedLocation!.organizationId,
      name: `__floorplan-test__ ${nameSuffix}`,
      timezone: 'Asia/Dubai',
    },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__floorplan-test__ Server', systemRole: 'STAFF' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__floorplan-test__ Manager', systemRole: 'MANAGER' },
  });
  const image = await prisma.floorPlanImage.create({
    data: {
      locationId: location.id,
      fileUrl: '/uploads/floor-plans/__floorplan-test__.png',
      originalName: '__floorplan-test__.png',
      mimeType: 'image/png',
    },
  });
  const section = await prisma.floorSection.create({
    data: {
      locationId: location.id,
      floorPlanImageId: image.id,
      label: '__floorplan-test__ Terrace',
      pinX: 0.25,
      pinY: 0.2,
      paxCapacity: 20,
      sortOrder: 0,
    },
  });

  return { location, staff, manager, image, section };
}

test('POST /api/floor-plan/assignments preserves an existing dutyLabel when the key is absent, and clears it when sent empty', async () => {
  const { location, staff, manager, section } = await createFixture('duty label');
  const shiftDate = '2031-04-04';

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const post = (body: Record<string, unknown>) =>
        fetch(`${baseUrl}/api/floor-plan/assignments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });

      // 1. Create the assignment WITH a duty label.
      const created = await post({ sectionId: section.id, staffId: staff.id, shiftDate, period: 'AM', dutyLabel: 'Section lead' });
      assert.equal(created.status, 201);
      const { assignment } = (await created.json()) as { assignment: { id: string; dutyLabel: string | null } };
      assert.equal(assignment.dutyLabel, 'Section lead');

      // 2. Re-upsert with NO dutyLabel key at all — a plain drag-drop
      //    reassign. The label must survive untouched.
      const reassigned = await post({ sectionId: section.id, staffId: staff.id, shiftDate, period: 'AM' });
      assert.equal(reassigned.status, 201);
      const afterReassign = (await reassigned.json()) as { assignment: { id: string; dutyLabel: string | null } };
      assert.equal(afterReassign.assignment.id, assignment.id, 'the upsert must hit the same row, not create a second one');
      assert.equal(afterReassign.assignment.dutyLabel, 'Section lead', 'omitting dutyLabel must not wipe the existing label');

      const persistedAfterReassign = await prisma.sectionAssignment.findUnique({ where: { id: assignment.id } });
      assert.equal(persistedAfterReassign!.dutyLabel, 'Section lead', 'the DB row itself must still carry the label');

      // 3. Re-upsert with dutyLabel explicitly empty — a real clear.
      const cleared = await post({ sectionId: section.id, staffId: staff.id, shiftDate, period: 'AM', dutyLabel: '' });
      assert.equal(cleared.status, 201);
      const afterClear = (await cleared.json()) as { assignment: { id: string; dutyLabel: string | null } };
      assert.equal(afterClear.assignment.id, assignment.id);
      assert.equal(afterClear.assignment.dutyLabel, null, 'an explicitly empty dutyLabel must clear the label');

      const persistedAfterClear = await prisma.sectionAssignment.findUnique({ where: { id: assignment.id } });
      assert.equal(persistedAfterClear!.dutyLabel, null, 'the DB row itself must have been cleared to null');
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('AM and PM assignments for the same section/staff/date are independent rows, each returned only for its own period', async () => {
  const { location, staff, manager, section } = await createFixture('am pm isolation');
  const shiftDate = '2031-04-05';

  try {
    const token = await sessionFor(manager.id);
    await withServer(async (baseUrl) => {
      const post = (period: 'AM' | 'PM', dutyLabel: string) =>
        fetch(`${baseUrl}/api/floor-plan/assignments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ sectionId: section.id, staffId: staff.id, shiftDate, period, dutyLabel }),
        });

      const amRes = await post('AM', 'Brunch lead');
      assert.equal(amRes.status, 201);
      const am = (await amRes.json()) as { assignment: { id: string; dutyLabel: string | null } };

      const pmRes = await post('PM', 'Dinner lead');
      assert.equal(pmRes.status, 201);
      const pm = (await pmRes.json()) as { assignment: { id: string; dutyLabel: string | null } };

      assert.notEqual(am.assignment.id, pm.assignment.id, 'PM must not overwrite the AM row via the upsert unique key');

      // Direct DB check: two genuinely separate rows.
      const rows = await prisma.sectionAssignment.findMany({
        where: { sectionId: section.id, staffId: staff.id, shiftDate: new Date(`${shiftDate}T00:00:00.000Z`) },
        orderBy: { period: 'asc' },
      });
      assert.equal(rows.length, 2, 'the same section/staff/date must hold one AM row and one PM row');
      assert.deepEqual(
        rows.map((r) => [r.period, r.dutyLabel]),
        [
          ['AM', 'Brunch lead'],
          ['PM', 'Dinner lead'],
        ],
      );

      // And the read endpoint returns exactly the one matching the period asked for.
      for (const [period, expected] of [
        ['AM', am.assignment.id],
        ['PM', pm.assignment.id],
      ] as const) {
        const res = await fetch(`${baseUrl}/api/floor-plan/${location.id}/assignments?date=${shiftDate}&period=${period}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { sections: { id: string; assignments: { id: string }[] }[] };
        const target = body.sections.find((s) => s.id === section.id);
        assert.ok(target, `section must be present in the ${period} response`);
        assert.equal(target!.assignments.length, 1, `${period} must return exactly one assignment`);
        assert.equal(target!.assignments[0].id, expected, `${period} must return its own assignment, not the other period's`);
      }
    });
  } finally {
    await prisma.sectionAssignment
      .deleteMany({ where: { sectionId: section.id, shiftDate: new Date(`${shiftDate}T00:00:00.000Z`) } })
      .catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('sections are pins: create/update validate pinX/pinY (0-1, moved together); one-release COMPAT keeps the old polygon-based frontend working', async () => {
  const { location, manager, image, section } = await createFixture('pins');
  try {
    await withServer(async (baseUrl) => {
      const token = await sessionFor(manager.id);
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const create = (body: Record<string, unknown>) =>
        fetch(`${baseUrl}/api/floor-plan/sections`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ locationId: location.id, floorPlanImageId: image.id, label: '__floorplan-test__ Bar', paxCapacity: 6, ...body }),
        });
      type Section = { id: string; pinX: number; pinY: number; polygon: { x: number; y: number }[] };
      const centre = (poly: { x: number; y: number }[]) => ({
        x: poly.reduce((n, p) => n + p.x, 0) / poly.length,
        y: poly.reduce((n, p) => n + p.y, 0) / poly.length,
      });

      // Missing / half / out-of-range / non-numeric pins are rejected, and so is a too-short legacy polygon.
      for (const bad of [{}, { pinX: 0.5 }, { pinX: 1.2, pinY: 0.5 }, { pinX: -0.1, pinY: 0.5 }, { pinX: '0.5', pinY: 0.5 }, { polygon: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }] }]) {
        const res = await create(bad);
        assert.equal(res.status, 400, `create must reject ${JSON.stringify(bad)}`);
      }

      // New frontend: a pin. It stores no boundary; the response's COMPAT polygon is a small square centred on the pin.
      const ok = await create({ pinX: 0.62, pinY: 0.86 });
      assert.equal(ok.status, 201);
      const { section: created } = (await ok.json()) as { section: Section };
      assert.equal(created.pinX, 0.62);
      assert.equal(created.pinY, 0.86);
      assert.deepEqual((await prisma.floorSection.findUniqueOrThrow({ where: { id: created.id } })).polygon, [], 'a pin section stores no boundary');
      assert.equal(created.polygon.length, 4);
      assert.ok(Math.abs(centre(created.polygon).x - 0.62) < 1e-9 && Math.abs(centre(created.polygon).y - 0.86) < 1e-9, 'compat square is centred on the pin');

      // COMPAT: the old frontend POSTs only a polygon — the pin is its vertex average, and the polygon comes back unchanged.
      const legacyPoly = [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.4 }];
      const legacy = await create({ polygon: legacyPoly });
      assert.equal(legacy.status, 201);
      const { section: legacySection } = (await legacy.json()) as { section: Section };
      assert.ok(Math.abs(legacySection.pinX - 0.3) < 1e-9 && Math.abs(legacySection.pinY - 0.2) < 1e-9);
      assert.deepEqual(legacySection.polygon, legacyPoly);

      const patch = (body: Record<string, unknown>) =>
        fetch(`${baseUrl}/api/floor-plan/sections/${section.id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
      assert.equal((await patch({ pinX: 0.3 })).status, 400, 'a pin is one point: never half-updated');
      assert.equal((await patch({ pinX: 0.3, pinY: 2 })).status, 400);
      const moved = await patch({ pinX: 0.3, pinY: 0.7 });
      assert.equal(moved.status, 200);
      const { section: updated } = (await moved.json()) as { section: Section };
      assert.equal(updated.pinX, 0.3);
      assert.equal(updated.pinY, 0.7);
      assert.ok(Math.abs(centre(updated.polygon).x - 0.3) < 1e-9 && Math.abs(centre(updated.polygon).y - 0.7) < 1e-9, 'compat square follows the moved pin');

      // Both read paths carry pins for the new frontend and a >=3-point polygon for the old one.
      for (const url of [`${baseUrl}/api/floor-plan/${location.id}`, `${baseUrl}/api/floor-plan/${location.id}/assignments?date=2026-10-01&period=AM`]) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { sections: Section[] };
        assert.equal(body.sections.length, 3);
        for (const s of body.sections) {
          assert.equal(typeof s.pinX, 'number');
          assert.equal(typeof s.pinY, 'number');
          assert.ok(Array.isArray(s.polygon) && s.polygon.length >= 3, `${url}: every section carries a usable compat polygon`);
        }
      }
    });
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
