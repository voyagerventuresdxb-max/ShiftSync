import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { publishRota } from './rotaActions.js';
import { createAnnouncement, createShoutout } from './communicationActions.js';

const prisma = new PrismaClient();
const TAG = '__audit-coverage-test__';

/**
 * Rota publish, announcements and shoutouts are venue-wide events staff act
 * on; each now leaves an AuditLog row, written in the same transaction as the
 * change, whichever entry point (REST or voice) called the shared action.
 */
async function venue() {
  const seed = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seed, 'seed data (a location) must exist to run this test');
  const location = await prisma.location.create({ data: { organizationId: seed!.organizationId, name: `${TAG} venue`, timezone: 'Asia/Dubai' } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: `${TAG} role` } });
  const manager = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} Manager`, systemRole: 'MANAGER' } });
  const staff = await prisma.user.create({ data: { locationId: location.id, fullName: `${TAG} Staff`, systemRole: 'STAFF', roleId: role.id } });
  return { location, role, manager, staff };
}

test('publishRota writes one ROTA_PUBLISHED audit row per publish, naming the publisher and the week', async () => {
  const { location, role, manager, staff } = await venue();
  try {
    const weekStart = new Date('2026-11-02T00:00:00.000Z');
    await prisma.shift.create({
      data: { locationId: location.id, roleId: role.id, userId: staff.id, date: weekStart, startTime: new Date('2026-11-02T05:00:00.000Z'), endTime: new Date('2026-11-02T13:00:00.000Z') },
    });
    const first = await publishRota({ locationId: location.id, weekStart, publishedById: manager.id });
    assert.equal(first.result, 'ok');
    const rows = await prisma.auditLog.findMany({ where: { locationId: location.id, action: 'ROTA_PUBLISHED' } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actorId, manager.id);
    assert.equal(rows[0]!.entityType, 'RotaPublish');
    assert.match(rows[0]!.note ?? '', /week of 2026-11-02/);
    assert.match(rows[0]!.note ?? '', /1 shift\(s\), 1 people notified/);
    const publish = await prisma.rotaPublish.findUniqueOrThrow({ where: { locationId_weekStart: { locationId: location.id, weekStart } } });
    assert.equal(rows[0]!.entityId, publish.id);

    // Re-publishing (the upsert path) is a second event, so a second row.
    await publishRota({ locationId: location.id, weekStart, publishedById: manager.id });
    assert.equal(await prisma.auditLog.count({ where: { locationId: location.id, action: 'ROTA_PUBLISHED' } }), 2);

    // An empty week publishes nothing and audits nothing.
    const empty = await publishRota({ locationId: location.id, weekStart: new Date('2026-11-09T00:00:00.000Z'), publishedById: manager.id });
    assert.equal(empty.result, 'empty');
    assert.equal(await prisma.auditLog.count({ where: { locationId: location.id, action: 'ROTA_PUBLISHED' } }), 2);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

test('createAnnouncement and createShoutout each write their audit row with the author as actor; a refused post writes none', async () => {
  const { location, manager, staff } = await venue();
  try {
    const announcement = await createAnnouncement({ locationId: location.id, authorId: manager.id, body: 'Team meeting at 15:00.' });
    assert.equal(announcement.result, 'ok');
    const aRows = await prisma.auditLog.findMany({ where: { locationId: location.id, action: 'ANNOUNCEMENT_POSTED' } });
    assert.equal(aRows.length, 1);
    assert.equal(aRows[0]!.actorId, manager.id);
    assert.equal(aRows[0]!.entityType, 'Announcement');
    assert.equal(aRows[0]!.entityId, (announcement as { announcement: { id: string } }).announcement.id);

    const shoutout = await createShoutout({ locationId: location.id, employeeId: staff.id, authorId: manager.id, shiftSnapshot: null, note: 'Great service tonight.' });
    assert.equal(shoutout.result, 'ok');
    const sRows = await prisma.auditLog.findMany({ where: { locationId: location.id, action: 'SHOUTOUT_POSTED' } });
    assert.equal(sRows.length, 1);
    assert.equal(sRows[0]!.actorId, manager.id);
    assert.equal(sRows[0]!.entityType, 'Shoutout');
    assert.equal(sRows[0]!.entityId, (shoutout as { shoutout: { id: string } }).shoutout.id);
    assert.match(sRows[0]!.note ?? '', new RegExp(`${TAG} Staff`));

    // Refusals leave no trace: too long, and a shoutout for someone at another venue.
    const tooLong = await createAnnouncement({ locationId: location.id, authorId: manager.id, body: 'x'.repeat(1001) });
    assert.equal(tooLong.result, 'too_long');
    const elsewhere = await createShoutout({ locationId: location.id, employeeId: 'nobody', authorId: manager.id, shiftSnapshot: null, note: 'n' });
    assert.equal(elsewhere.result, 'employee_not_found');
    assert.equal(await prisma.auditLog.count({ where: { locationId: location.id, action: { in: ['ANNOUNCEMENT_POSTED', 'SHOUTOUT_POSTED'] } } }), 2);
  } finally {
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
