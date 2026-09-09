import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { upsertSectionAssignment } from './sectionActions.js';

const prisma = new PrismaClient();

test('upsertSectionAssignment creates then re-assigns without clobbering an unset dutyLabel key', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const staff = await prisma.user.findFirst({ where: { locationId: location!.id } });
  const floorPlanImage = await prisma.floorPlanImage.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && staff && floorPlanImage, 'seed data (location, staff, floor plan image) must exist to run this test');

  const section = await prisma.floorSection.create({
    data: { locationId: location!.id, floorPlanImageId: floorPlanImage!.id, label: '__task3-test__ section', polygon: [], paxCapacity: 4 },
  });
  const shiftDate = new Date('2026-09-21T00:00:00.000Z');

  try {
    const created = await upsertSectionAssignment({
      sectionId: section.id, staffId: staff!.id, shiftDate, period: 'AM', dutyLabel: 'Host', createdById: staff!.id, touchDutyLabel: true,
    });
    assert.equal(created.dutyLabel, 'Host');

    const reassigned = await upsertSectionAssignment({
      sectionId: section.id, staffId: staff!.id, shiftDate, period: 'AM', dutyLabel: null, createdById: staff!.id, touchDutyLabel: false,
    });
    assert.equal(reassigned.id, created.id, 'same compound key must upsert the same row');
    assert.equal(reassigned.dutyLabel, 'Host', 'touchDutyLabel:false must not clobber the existing label');
  } finally {
    await prisma.sectionAssignment.deleteMany({ where: { sectionId: section.id } });
    await prisma.floorSection.delete({ where: { id: section.id } }).catch(() => {});
  }
});
