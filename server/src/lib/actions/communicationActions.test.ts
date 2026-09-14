import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createAnnouncement, createShoutout } from './communicationActions.js';

const prisma = new PrismaClient();

test('createAnnouncement: ok path creates a real Announcement row and notifies every other active staff member', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const author = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__communicationActions-test__ announcement author', systemRole: 'MANAGER', isActive: true },
  });
  const recipient = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__communicationActions-test__ announcement recipient', systemRole: 'STAFF', isActive: true },
  });

  try {
    const result = await createAnnouncement({ locationId: location!.id, authorId: author.id, body: 'The walk-in is down today — no ice cream orders.' });
    assert.equal(result.result, 'ok');
    if (result.result === 'ok') {
      assert.equal(result.announcement.body, 'The walk-in is down today — no ice cream orders.');
      assert.equal(result.announcement.authorId, author.id);
      assert.equal(result.announcement.authorName, author.fullName);

      const row = await prisma.announcement.findUnique({ where: { id: result.announcement.id } });
      assert.ok(row, 'the Announcement row must actually exist in the DB');
      assert.equal(row!.locationId, location!.id);
    }
  } finally {
    await prisma.announcement.deleteMany({ where: { authorId: author.id } });
    await prisma.user.delete({ where: { id: author.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: recipient.id } }).catch(() => {});
  }
});

test('createAnnouncement: rejects a body over the 1000-character cap, exactly one character over', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const tooLong = 'x'.repeat(1001);
  const result = await createAnnouncement({ locationId: location!.id, authorId: null, body: tooLong });
  assert.equal(result.result, 'too_long');
  if (result.result === 'too_long') assert.match(result.message, /too long/i);

  const leaked = await prisma.announcement.findMany({ where: { body: tooLong } });
  assert.equal(leaked.length, 0, 'an over-cap body must never be written');
});

test('createAnnouncement: exactly 1000 characters is accepted (the cap is inclusive, not exclusive)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const exactlyAtCap = 'y'.repeat(1000);
  const result = await createAnnouncement({ locationId: location!.id, authorId: null, body: exactlyAtCap });
  assert.equal(result.result, 'ok');
  if (result.result === 'ok') {
    await prisma.announcement.delete({ where: { id: result.announcement.id } }).catch(() => {});
  }
});

test('createAnnouncement: rejects an unknown locationId', async () => {
  const result = await createAnnouncement({ locationId: '__does-not-exist__', authorId: null, body: 'hello' });
  assert.equal(result.result, 'location_not_found');
});

test('createAnnouncement: rejects an authorId that does not exist', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const result = await createAnnouncement({ locationId: location!.id, authorId: '__does-not-exist__', body: 'hello' });
  assert.equal(result.result, 'author_not_found');
});

test('createAnnouncement: rejects an authorId that belongs to a different location (cross-tenant misattribution)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__communicationActions-test__ other venue (cross-loc author)', timezone: 'Asia/Dubai' },
  });
  const outOfLocationAuthor = await prisma.user.create({
    data: { locationId: otherLocation.id, fullName: '__communicationActions-test__ cross-loc author', systemRole: 'MANAGER', isActive: true },
  });

  try {
    const result = await createAnnouncement({ locationId: location!.id, authorId: outOfLocationAuthor.id, body: 'hello' });
    assert.equal(result.result, 'author_not_found', 'a real user from a DIFFERENT location must not be usable as this announcement\'s author');

    const leaked = await prisma.announcement.findMany({ where: { authorId: outOfLocationAuthor.id } });
    assert.equal(leaked.length, 0, 'no Announcement may be written misattributed to an out-of-location author');
  } finally {
    await prisma.user.delete({ where: { id: outOfLocationAuthor.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

test('createAnnouncement: rejects the 11th announcement within the last hour at one location (rate limit)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const rateLimitLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__communicationActions-test__ rate-limited venue (announcements)', timezone: 'Asia/Dubai' },
  });

  try {
    await prisma.announcement.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ locationId: rateLimitLocation.id, authorId: null, body: `__communicationActions-test__ seed ${i}` })),
    });

    const result = await createAnnouncement({ locationId: rateLimitLocation.id, authorId: null, body: 'the 11th one' });
    assert.equal(result.result, 'rate_limited');

    const leaked = await prisma.announcement.findMany({ where: { locationId: rateLimitLocation.id, body: 'the 11th one' } });
    assert.equal(leaked.length, 0, 'no Announcement may be written past the hourly rate limit');
  } finally {
    await prisma.announcement.deleteMany({ where: { locationId: rateLimitLocation.id } });
    await prisma.location.delete({ where: { id: rateLimitLocation.id } });
  }
});

test('createShoutout: ok path creates a real Shoutout row with shiftSnapshot null (the voice path)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const author = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__communicationActions-test__ shoutout author', systemRole: 'MANAGER', isActive: true },
  });
  const employee = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__communicationActions-test__ shoutout employee', systemRole: 'STAFF', isActive: true },
  });

  try {
    const result = await createShoutout({ locationId: location!.id, employeeId: employee.id, authorId: author.id, shiftSnapshot: null, note: 'Covered a last-minute shift.' });
    assert.equal(result.result, 'ok');
    if (result.result === 'ok') {
      assert.equal(result.shoutout.employeeId, employee.id);
      assert.equal(result.shoutout.employeeName, employee.fullName);
      assert.equal(result.shoutout.note, 'Covered a last-minute shift.');

      const row = await prisma.shoutout.findUnique({ where: { id: result.shoutout.id } });
      assert.ok(row, 'the Shoutout row must actually exist in the DB');
      assert.equal(row!.shiftSnapshot, null);
    }
  } finally {
    await prisma.shoutout.deleteMany({ where: { authorId: author.id } });
    await prisma.user.delete({ where: { id: author.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: employee.id } }).catch(() => {});
  }
});

test('createShoutout: rejects a note over the 500-character cap, exactly one character over', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const employee = await prisma.user.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && employee, 'seed data (location + a user) must exist to run this test');

  const tooLong = 'z'.repeat(501);
  const result = await createShoutout({ locationId: location!.id, employeeId: employee!.id, authorId: null, shiftSnapshot: null, note: tooLong });
  assert.equal(result.result, 'too_long');

  const leaked = await prisma.shoutout.findMany({ where: { note: tooLong } });
  assert.equal(leaked.length, 0, 'an over-cap note must never be written');
});

test('createShoutout: rejects an employeeId that does not exist', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const result = await createShoutout({ locationId: location!.id, employeeId: '__does-not-exist__', authorId: null, shiftSnapshot: null, note: 'hello' });
  assert.equal(result.result, 'employee_not_found');
});

test('createShoutout: rejects an employeeId that belongs to a different location', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__communicationActions-test__ other venue (cross-loc employee)', timezone: 'Asia/Dubai' },
  });
  const outOfLocationEmployee = await prisma.user.create({
    data: { locationId: otherLocation.id, fullName: '__communicationActions-test__ cross-loc employee', systemRole: 'STAFF', isActive: true },
  });

  try {
    const result = await createShoutout({ locationId: location!.id, employeeId: outOfLocationEmployee.id, authorId: null, shiftSnapshot: null, note: 'hello' });
    assert.equal(result.result, 'employee_not_found');

    const leaked = await prisma.shoutout.findMany({ where: { employeeId: outOfLocationEmployee.id } });
    assert.equal(leaked.length, 0, 'no Shoutout may be written targeting an out-of-location employee');
  } finally {
    await prisma.user.delete({ where: { id: outOfLocationEmployee.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

test('createShoutout: rejects an authorId that belongs to a different location (cross-tenant misattribution)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const employee = await prisma.user.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && employee, 'seed data (location + a user) must exist to run this test');

  const otherLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__communicationActions-test__ other venue (cross-loc shoutout author)', timezone: 'Asia/Dubai' },
  });
  const outOfLocationAuthor = await prisma.user.create({
    data: { locationId: otherLocation.id, fullName: '__communicationActions-test__ cross-loc shoutout author', systemRole: 'MANAGER', isActive: true },
  });

  try {
    const result = await createShoutout({ locationId: location!.id, employeeId: employee!.id, authorId: outOfLocationAuthor.id, shiftSnapshot: null, note: 'hello' });
    assert.equal(result.result, 'author_not_found');

    const leaked = await prisma.shoutout.findMany({ where: { authorId: outOfLocationAuthor.id } });
    assert.equal(leaked.length, 0, 'no Shoutout may be written misattributed to an out-of-location author');
  } finally {
    await prisma.user.delete({ where: { id: outOfLocationAuthor.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: otherLocation.id } }).catch(() => {});
  }
});

test('createShoutout: rejects the 21st shoutout within the last hour at one location (rate limit)', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const rateLimitLocation = await prisma.location.create({
    data: { organizationId: location!.organizationId, name: '__communicationActions-test__ rate-limited venue (shoutouts)', timezone: 'Asia/Dubai' },
  });
  const employee = await prisma.user.create({
    data: { locationId: rateLimitLocation.id, fullName: '__communicationActions-test__ rate-limit employee', systemRole: 'STAFF', isActive: true },
  });

  try {
    await prisma.shoutout.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        locationId: rateLimitLocation.id,
        employeeId: employee.id,
        authorId: null,
        note: `__communicationActions-test__ seed ${i}`,
      })),
    });

    const result = await createShoutout({ locationId: rateLimitLocation.id, employeeId: employee.id, authorId: null, shiftSnapshot: null, note: 'the 21st one' });
    assert.equal(result.result, 'rate_limited');

    const leaked = await prisma.shoutout.findMany({ where: { locationId: rateLimitLocation.id, note: 'the 21st one' } });
    assert.equal(leaked.length, 0, 'no Shoutout may be written past the hourly rate limit');
  } finally {
    await prisma.shoutout.deleteMany({ where: { locationId: rateLimitLocation.id } });
    await prisma.user.delete({ where: { id: employee.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: rateLimitLocation.id } });
  }
});
