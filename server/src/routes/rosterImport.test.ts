import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { uploadCache } from '../store/uploadCache.js';
import { resolveRowsAgainstDatabase, TEAM_MEMBER_ROLE_NAME } from '../parsing/resolveRows.js';
import type { ParsedShiftRow } from '../parsing/types.js';
import type { ConfirmImportResult, PersonPreview, ReadPerson, RowReadingInfo } from '../parsing/rosterContract.js';

/**
 * Roster import confirm, end to end through the real route (2026-10 review rework): every
 * person becomes or links to a real staff member, a second or third import of the same
 * people creates nobody new, identical shifts are skipped, close names are never merged
 * without the manager, and a role never blocks. Batches are staged exactly like
 * POST /upload does (resolveRowsAgainstDatabase -> uploadCache.put); one test goes through
 * the real upload endpoint with a CSV. Made-up names only.
 */

const prisma = new PrismaClient();
const TAG = '__roster-import-test__';

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

interface Venue {
  locationId: string;
  managerId: string;
  token: string;
  cleanup: () => Promise<void>;
}

async function makeVenue(label: string): Promise<Venue> {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `${TAG} ${label}`, timezone: 'Asia/Dubai' } });
  await prisma.role.create({ data: { locationId: location.id, name: 'Waiter' } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} manager`, systemRole: 'MANAGER' } });
  const { plainToken } = await issueSession(manager.id);
  return {
    locationId: location.id,
    managerId: manager.id,
    token: plainToken,
    cleanup: async () => {
      await prisma.auditLog.deleteMany({ where: { locationId: location.id } });
      await prisma.shift.deleteMany({ where: { locationId: location.id } });
      await prisma.session.deleteMany({ where: { user: { locationId: location.id } } });
      await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
    },
  };
}

type Row = ParsedShiftRow & RowReadingInfo;

function shift(name: string, sourceRowIndex: number, date: string, overrides: Partial<Row> = {}): Row {
  return {
    rowNumber: 0,
    sourceRowIndex,
    employeeName: name,
    roleName: 'Waiter',
    date,
    startTime: '17:00',
    endTime: '23:00',
    overnight: false,
    breakMinutes: 0,
    managerNotes: null,
    ...overrides,
  };
}

/** Stages a batch exactly like POST /upload: resolve against the venue, cache rows + people. */
async function stage(locationId: string, rows: Row[], readPeople?: ReadPerson[]): Promise<{ batchId: string; people: PersonPreview[] }> {
  const numbered = rows.map((r, i) => ({ ...r, rowNumber: i + 1 }));
  const { previewRows, people } = await resolveRowsAgainstDatabase(prisma, locationId, numbered, { readPeople });
  return { batchId: uploadCache.put(locationId, null, previewRows, { people }), people };
}

/** The review screen's untouched preselection, as the client sends it. */
function suggested(people: PersonPreview[]) {
  return people.map((p) => ({ personKey: p.personKey, action: p.suggestedAction ?? 'create', ...(p.suggestedAction === 'link' ? { userId: p.suggestedUserId } : {}) }));
}

type ConfirmBody = ConfirmImportResult & { createdCount: number; skippedCount: number; rows: { rowNumber: number; shiftId: string; userId: string | null; date: string }[] };

async function confirm(baseUrl: string, token: string, batchId: string, body: Record<string, unknown>): Promise<{ status: number; body: ConfirmBody & { error?: string } }> {
  const res = await fetch(`${baseUrl}/api/schedules/upload/${batchId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ConfirmBody & { error?: string } };
}

const WEEK_A = ['2031-03-03', '2031-03-04', '2031-03-05'];
const WEEK_B = ['2031-03-10', '2031-03-11', '2031-03-12'];
const CREW = [`${TAG} Ava Thornton`, `${TAG} Ben Okafor`, `${TAG} Cleo Varga`];

function crewWeek(dates: string[]): Row[] {
  return CREW.flatMap((name, i) => dates.map((date) => shift(name, i + 1, date, i === 2 ? { roleName: 'Wine Steward' } : {})));
}

test('second roster, same format: week A creates everyone; week B matches all of them; week A again creates nothing', async () => {
  const venue = await makeVenue('second roster');
  try {
    await withServer(async (baseUrl) => {
      const a = await stage(venue.locationId, crewWeek(WEEK_A));
      assert.equal(a.people.length, 3, 'three people, not nine rows');
      const first = await confirm(baseUrl, venue.token, a.batchId, { createdById: venue.managerId, weekStart: '2031-03-03', people: suggested(a.people) });
      assert.equal(first.status, 201, first.body.error ?? '');
      assert.equal(first.body.createdPeople, 3);
      assert.equal(first.body.createdShifts, 9);
      assert.equal(first.body.createdCount, 9, 'the older field still reports shifts written');
      assert.equal(first.body.weekStart, '2031-03-03');

      const b = await stage(venue.locationId, crewWeek(WEEK_B));
      assert.ok(b.people.every((p) => p.status === 'matched'), 'the second roster matches every person');
      const second = await confirm(baseUrl, venue.token, b.batchId, { weekStart: '2031-03-10', people: suggested(b.people) });
      assert.equal(second.status, 201, second.body.error ?? '');
      assert.equal(second.body.createdPeople, 0);
      assert.equal(second.body.linkedPeople, 3);
      assert.equal(second.body.createdShifts, 9);
      assert.ok(second.body.rows.every((r) => WEEK_B.includes(r.date)), 'week B shifts land in week B');

      const again = await stage(venue.locationId, crewWeek(WEEK_A));
      const third = await confirm(baseUrl, venue.token, again.batchId, { people: suggested(again.people) });
      assert.equal(third.status, 201, third.body.error ?? '');
      assert.equal(third.body.createdPeople, 0);
      assert.equal(third.body.createdShifts, 0);
      assert.equal(third.body.skippedDuplicates, 9);
    });

    assert.equal(await prisma.user.count({ where: { locationId: venue.locationId, systemRole: 'STAFF' } }), 3);
    assert.equal(await prisma.shift.count({ where: { locationId: venue.locationId } }), 18);
    const cleo = await prisma.user.findFirst({ where: { locationId: venue.locationId, fullName: CREW[2] }, include: { role: true } });
    assert.equal(cleo?.role?.name, TEAM_MEMBER_ROLE_NAME, 'a role-unresolved person is imported, under "Team member"');
  } finally {
    await venue.cleanup();
  }
});

test('an older client (no people decisions) still gets everyone imported, and a repeat is a no-op', async () => {
  const venue = await makeVenue('legacy body');
  try {
    await withServer(async (baseUrl) => {
      const a = await stage(venue.locationId, crewWeek(WEEK_A));
      const first = await confirm(baseUrl, venue.token, a.batchId, {});
      assert.equal(first.status, 201, first.body.error ?? '');
      assert.equal(first.body.createdPeople, 3);
      assert.equal(first.body.createdCount, 9);
      const again = await stage(venue.locationId, crewWeek(WEEK_A));
      const second = await confirm(baseUrl, venue.token, again.batchId, { createdById: venue.managerId });
      assert.equal(second.body.createdCount, 0);
      assert.equal(second.body.skippedCount, 9);
    });
  } finally {
    await venue.cleanup();
  }
});

test('close names are never merged without the manager; "same person" links and is remembered for next time', async () => {
  const venue = await makeVenue('nickname');
  const bastian = await prisma.user.create({ data: { locationId: venue.locationId, fullName: `${TAG} Bastian Rao`, systemRole: 'STAFF' } });
  try {
    await withServer(async (baseUrl) => {
      // No decision sent: the nickname becomes a NEW person, never silently merged.
      const a = await stage(venue.locationId, [shift(`${TAG} Bast`, 1, WEEK_A[0]!)]);
      assert.equal(a.people[0]!.status, 'needs_decision');
      assert.equal(a.people[0]!.suggestedAction, 'create', 'a nickname is never preselected as the same person');
      const legacy = await confirm(baseUrl, venue.token, a.batchId, {});
      assert.equal(legacy.body.createdPeople, 1);
      assert.equal((await prisma.shift.count({ where: { userId: bastian.id } })), 0);
      await prisma.user.deleteMany({ where: { locationId: venue.locationId, fullName: `${TAG} Bast` } });

      // The manager says "same person".
      const b = await stage(venue.locationId, [shift(`${TAG} Bast`, 1, WEEK_A[1]!)]);
      const linked = await confirm(baseUrl, venue.token, b.batchId, { people: [{ personKey: b.people[0]!.personKey, action: 'link', userId: bastian.id }] });
      assert.equal(linked.status, 201, linked.body.error ?? '');
      assert.equal(linked.body.linkedPeople, 1);
      assert.equal(linked.body.createdPeople, 0);
      assert.equal(await prisma.shift.count({ where: { userId: bastian.id } }), 1);

      // Next import: "Bast" is matched straight away.
      const c = await stage(venue.locationId, [shift(`${TAG} Bast`, 1, WEEK_B[0]!)]);
      assert.equal(c.people[0]!.status, 'matched');
      assert.equal(c.people[0]!.matchedUserId, bastian.id);
    });
  } finally {
    await venue.cleanup();
  }
});

test('the same name listed twice / in two sections: flagged, not merged in preview; "same person" makes one staff member, a rename makes two', async () => {
  const venue = await makeVenue('duplicates');
  try {
    await withServer(async (baseUrl) => {
      const rows = [
        shift(`${TAG} Lena Park`, 1, WEEK_A[0]!, { section: 'WAITERS' }),
        shift(`${TAG} Lena Park`, 2, WEEK_A[1]!, { section: 'BAR' }),
        shift(`${TAG} Theo Grant`, 3, WEEK_A[0]!),
        shift(`${TAG} Theo Grant`, 4, WEEK_A[2]!),
      ];
      const a = await stage(venue.locationId, rows);
      assert.equal(a.people.length, 4);
      assert.ok(a.people.every((p) => p.status === 'needs_decision'));
      assert.ok(a.people.filter((p) => p.name.endsWith('Lena Park')).every((p) => p.flags.some((f) => f.kind === 'two_sections')));
      const [lena1, lena2, theo1, theo2] = a.people;
      const res = await confirm(baseUrl, venue.token, a.batchId, {
        people: [
          { personKey: lena1!.personKey, action: 'create' },
          { personKey: lena2!.personKey, action: 'create' },
          { personKey: theo1!.personKey, action: 'create' },
          { personKey: theo2!.personKey, action: 'create', name: `${TAG} Theo Grant Jr` },
        ],
      });
      assert.equal(res.status, 201, res.body.error ?? '');
      assert.equal(res.body.createdPeople, 3, 'Lena once (same person), Theo twice (renamed)');
      assert.equal(res.body.createdShifts, 4);
    });
    const lenas = await prisma.user.findMany({ where: { locationId: venue.locationId, fullName: `${TAG} Lena Park` } });
    assert.equal(lenas.length, 1);
    assert.equal(await prisma.shift.count({ where: { userId: lenas[0]!.id } }), 2, 'both sections\' shifts belong to the one Lena');
  } finally {
    await venue.cleanup();
  }
});

test('role unresolved is non-blocking; a bulk-assigned role is used and remembered for the next import', async () => {
  const venue = await makeVenue('roles');
  try {
    await withServer(async (baseUrl) => {
      const a = await stage(venue.locationId, [shift(`${TAG} Ava Thornton`, 1, WEEK_A[0]!, { roleName: 'Wine Steward' })]);
      assert.ok(a.people[0]!.flags.some((f) => f.kind === 'role_unresolved'));
      const res = await confirm(baseUrl, venue.token, a.batchId, {
        rememberRoleMappings: true,
        people: [{ personKey: a.people[0]!.personKey, action: 'create', roleName: 'Sommelier' }],
      });
      assert.equal(res.status, 201, res.body.error ?? '');
      assert.equal(res.body.people[0]!.roleName, 'Sommelier');
      const user = await prisma.user.findFirst({ where: { locationId: venue.locationId, fullName: `${TAG} Ava Thornton` }, include: { role: true } });
      assert.equal(user?.role?.name, 'Sommelier');

      const b = await stage(venue.locationId, [shift(`${TAG} Ben Okafor`, 1, WEEK_A[0]!, { roleName: 'wine steward' })]);
      assert.equal(
        b.people[0]!.flags.some((f) => f.kind === 'role_unresolved'),
        false,
        'the remembered label resolves next time',
      );
      assert.equal(b.people[0]!.resolvedRoleId, user!.roleId);
    });
  } finally {
    await venue.cleanup();
  }
});

test('a confirmed week different from the detected one moves every shift by whole weeks; a non-Monday is refused', async () => {
  const venue = await makeVenue('week override');
  try {
    await withServer(async (baseUrl) => {
      const a = await stage(venue.locationId, [shift(`${TAG} Ava Thornton`, 1, '2031-03-03'), shift(`${TAG} Ava Thornton`, 1, '2031-03-09')]);
      const bad = await confirm(baseUrl, venue.token, a.batchId, { weekStart: '2031-03-18' });
      assert.equal(bad.status, 400);
      const res = await confirm(baseUrl, venue.token, a.batchId, { weekStart: '2031-03-17', people: suggested(a.people) });
      assert.equal(res.status, 201, res.body.error ?? '');
      assert.deepEqual(res.body.rows.map((r) => r.date).sort(), ['2031-03-17', '2031-03-23']);
      assert.equal(res.body.weekStart, '2031-03-17');
    });
    const dates = (await prisma.shift.findMany({ where: { locationId: venue.locationId }, select: { date: true } })).map((s) => s.date.toISOString().slice(0, 10)).sort();
    assert.deepEqual(dates, ['2031-03-17', '2031-03-23']);
  } finally {
    await venue.cleanup();
  }
});

test('linking to a staff member of another venue is refused (400) and nothing is written', async () => {
  const venue = await makeVenue('cross venue');
  const other = await makeVenue('cross venue other');
  const outsider = await prisma.user.create({ data: { locationId: other.locationId, fullName: `${TAG} Ava Thornton`, systemRole: 'STAFF' } });
  try {
    await withServer(async (baseUrl) => {
      const a = await stage(venue.locationId, [shift(`${TAG} Ava Thornton`, 1, WEEK_A[0]!)]);
      const res = await confirm(baseUrl, venue.token, a.batchId, { people: [{ personKey: a.people[0]!.personKey, action: 'link', userId: outsider.id }] });
      assert.equal(res.status, 400);
      const unknown = await confirm(baseUrl, venue.token, a.batchId, { people: [{ personKey: 'not-a-person', action: 'create' }] });
      assert.equal(unknown.status, 400);
    });
    assert.equal(await prisma.shift.count({ where: { locationId: { in: [venue.locationId, other.locationId] } } }), 0);
    assert.equal(await prisma.user.count({ where: { locationId: venue.locationId, systemRole: 'STAFF' } }), 0);
  } finally {
    await venue.cleanup();
    await other.cleanup();
  }
});

test('double-submit: two confirms of the same batch at once create each person and shift once', async () => {
  const venue = await makeVenue('double submit');
  try {
    await withServer(async (baseUrl) => {
      const a = await stage(venue.locationId, crewWeek(WEEK_A));
      const body = { people: suggested(a.people) };
      const results = await Promise.all([confirm(baseUrl, venue.token, a.batchId, body), confirm(baseUrl, venue.token, a.batchId, body)]);
      assert.ok(results.some((r) => r.status === 201));
      assert.ok(results.every((r) => r.status === 201 || r.status === 404), JSON.stringify(results.map((r) => r.status)));
    });
    assert.equal(await prisma.user.count({ where: { locationId: venue.locationId, systemRole: 'STAFF' } }), 3);
    assert.equal(await prisma.shift.count({ where: { locationId: venue.locationId } }), 9);
  } finally {
    await venue.cleanup();
  }
});

test('a different shift overlapping one the person already works is not written, and is listed', async () => {
  const venue = await makeVenue('overlap');
  try {
    await withServer(async (baseUrl) => {
      const a = await stage(venue.locationId, [shift(`${TAG} Ava Thornton`, 1, WEEK_A[0]!, { startTime: '10:00', endTime: '18:00' })]);
      await confirm(baseUrl, venue.token, a.batchId, { people: suggested(a.people) });
      const b = await stage(venue.locationId, [
        shift(`${TAG} Ava Thornton`, 1, WEEK_A[0]!, { startTime: '12:00', endTime: '20:00' }),
        shift(`${TAG} Ava Thornton`, 1, WEEK_A[1]!, { startTime: '12:00', endTime: '20:00' }),
      ]);
      const res = await confirm(baseUrl, venue.token, b.batchId, { people: suggested(b.people) });
      assert.equal(res.status, 201, res.body.error ?? '');
      assert.equal(res.body.createdShifts, 1);
      assert.equal(res.body.overlaps.length, 1);
      assert.deepEqual(res.body.overlaps[0]!.existing, { date: WEEK_A[0], startTime: '10:00', endTime: '18:00' });
    });
  } finally {
    await venue.cleanup();
  }
});

test('added people and skipped people: an added person becomes staff with no shifts; a skipped one is not imported', async () => {
  const venue = await makeVenue('added skipped');
  try {
    await withServer(async (baseUrl) => {
      const a = await stage(venue.locationId, [shift(`${TAG} Ava Thornton`, 1, WEEK_A[0]!), shift(`${TAG} Ben Okafor`, 2, WEEK_A[0]!)]);
      const res = await confirm(baseUrl, venue.token, a.batchId, {
        people: [
          { personKey: a.people[0]!.personKey, action: 'create' },
          { personKey: a.people[1]!.personKey, action: 'skip' },
        ],
        addedPeople: [{ name: `${TAG} Dara Quinn`, roleName: 'Host' }],
      });
      assert.equal(res.status, 201, res.body.error ?? '');
      assert.equal(res.body.createdPeople, 2);
      assert.equal(res.body.skippedPeople, 1);
      assert.equal(res.body.createdShifts, 1);
    });
    const names = (await prisma.user.findMany({ where: { locationId: venue.locationId, systemRole: 'STAFF' }, include: { role: true } })).map((u) => `${u.fullName}|${u.role?.name}`).sort();
    assert.deepEqual(names, [`${TAG} Ava Thornton|Waiter`, `${TAG} Dara Quinn|Host`]);
  } finally {
    await venue.cleanup();
  }
});

test('a person the reader saw with no shifts that week (leave / colour only) still becomes staff', async () => {
  const venue = await makeVenue('zero shift');
  try {
    await withServer(async (baseUrl) => {
      const rows = [shift(`${TAG} Ava Thornton`, 1, WEEK_A[0]!, { personKey: 'p1' })];
      const readPeople: ReadPerson[] = [
        { personKey: 'p1', name: `${TAG} Ava Thornton`, roleLabel: 'Waiter', section: null, sourcePage: null, sourceRow: 2, readerSource: 'table' },
        { personKey: 'p2', name: `${TAG} Ben Okafor`, roleLabel: 'Waiter 2', section: null, sourcePage: null, sourceRow: 3, readerSource: 'table' },
      ];
      const a = await stage(venue.locationId, rows, readPeople);
      assert.equal(a.people.length, 2);
      assert.equal(a.people[1]!.shiftCount, 0);
      const res = await confirm(baseUrl, venue.token, a.batchId, { people: suggested(a.people) });
      assert.equal(res.status, 201, res.body.error ?? '');
      assert.equal(res.body.createdPeople, 2);
      assert.equal(res.body.createdShifts, 1);
    });
    const ben = await prisma.user.findFirst({ where: { locationId: venue.locationId, fullName: `${TAG} Ben Okafor` }, include: { role: true } });
    assert.equal(ben?.role?.name, 'Waiter', '"Waiter 2" is the Waiter role');
  } finally {
    await venue.cleanup();
  }
});

test('POST /upload (a CSV) returns one person per person, summary.people counting people, and confirm imports them all', async () => {
  const venue = await makeVenue('real upload');
  try {
    await withServer(async (baseUrl) => {
      const csv = [
        'Employee Name,Role,Date,Start Time,End Time',
        `${TAG} Ava Thornton,Waiter,2031-04-07,17:00,23:00`,
        `${TAG} Ava Thornton,Waiter,2031-04-08,17:00,23:00`,
        `${TAG} Ben Okafor,Busser,2031-04-07,18:00,02:00`,
      ].join('\n');
      const form = new FormData();
      form.append('file', new Blob([csv], { type: 'text/csv' }), 'roster.csv');
      form.append('weekStart', '2031-04-07');
      const up = await fetch(`${baseUrl}/api/schedules/upload`, { method: 'POST', headers: { Authorization: `Bearer ${venue.token}` }, body: form });
      assert.equal(up.status, 200);
      const preview = (await up.json()) as { batchId: string; people: PersonPreview[]; summary: { totalRows: number; people: { total: number; roleUnresolved: number } } };
      assert.equal(preview.summary.totalRows, 3);
      assert.equal(preview.summary.people.total, 2);
      assert.equal(preview.summary.people.roleUnresolved, 1);
      const res = await confirm(baseUrl, venue.token, preview.batchId, { weekStart: '2031-04-07', people: suggested(preview.people) });
      assert.equal(res.status, 201, res.body.error ?? '');
      assert.equal(res.body.createdPeople, 2);
      assert.equal(res.body.createdShifts, 3);
    });
  } finally {
    await venue.cleanup();
  }
});
