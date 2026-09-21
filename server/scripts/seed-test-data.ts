/**
 * Minimal seed for exercising the upload->confirm flow end-to-end.
 * Creates one Organization, one Location, 5 Roles, 2 active Users, and one
 * FloorPlanImage (the minimum the server test suite expects to find).
 * Idempotent: safe to re-run (upserts by unique name).
 *
 * Usage: npx tsx server/scripts/seed-test-data.ts
 */
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const org = await prisma.organization.upsert({
    where: { id: 'seed-org' },
    update: {},
    create: { id: 'seed-org', name: 'ShiftSync Test Restaurant Group' },
  });

  const location = await prisma.location.upsert({
    where: { id: 'seed-location' },
    update: {},
    create: {
      id: 'seed-location',
      organizationId: org.id,
      name: 'Downtown Dubai Test Venue',
      emirate: 'Dubai',
    },
  });

  const roleNames = ['Bartender', 'Floor Staff', 'Host', 'Chef', 'Runner'];
  const roles = await Promise.all(
    roleNames.map((name) =>
      prisma.role.upsert({
        where: { locationId_name: { locationId: location.id, name } },
        update: {},
        create: { locationId: location.id, name },
      }),
    ),
  );
  const bartenderRole = roles.find((r) => r.name === 'Bartender')!;

  const users = await Promise.all([
    prisma.user.upsert({
      where: { email: 'ahmed.khan@seed.test' },
      update: {},
      create: {
        locationId: location.id,
        roleId: bartenderRole.id,
        fullName: 'Ahmed Khan',
        email: 'ahmed.khan@seed.test',
        baseMonthlySalary: 4500,
      },
    }),
    prisma.user.upsert({
      where: { email: 'fatima.alsuwaidi@seed.test' },
      update: {},
      create: {
        locationId: location.id,
        roleId: roles.find((r) => r.name === 'Floor Staff')!.id,
        fullName: 'Fatima Al Suwaidi',
        email: 'fatima.alsuwaidi@seed.test',
        baseMonthlySalary: 4000,
      },
    }),
  ]);

  // A floor-plan image row for the seed venue. Four server tests
  // (sectionActions.test.ts, voice.test.ts's ASSIGN_SECTION + compound-
  // transcript cases) look one up on the first location and bail with
  // "seed data (... floor plan image) must exist" otherwise. On the old
  // shared cloud DB one happened to exist from manual use; a fresh local
  // Postgres has nothing until it's seeded here. No real file is needed —
  // those tests only read the row and create their own sections under it.
  const floorPlanImage = await prisma.floorPlanImage.upsert({
    where: { id: 'seed-floor-plan' },
    update: {},
    create: {
      id: 'seed-floor-plan',
      locationId: location.id,
      fileUrl: '/uploads/floor-plans/seed-floor-plan.png',
      originalName: 'seed-floor-plan.png',
      mimeType: 'image/png',
    },
  });

  console.log('Seeded:');
  console.log('  organizationId:', org.id);
  console.log('  locationId:', location.id);
  console.log('  roles:', roles.map((r) => r.name).join(', '));
  console.log('  users:', users.map((u) => u.fullName).join(', '));
  console.log('  floorPlanImageId:', floorPlanImage.id);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
