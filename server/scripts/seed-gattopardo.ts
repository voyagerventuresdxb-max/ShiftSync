/**
 * Seeds `seed-location` with the staff and roles from the real Gattopardo
 * roster ("Gattopardo rota 17-23 Aug.pdf") so that roster uploads resolve to
 * `matchedRows` in the browser UI instead of `unmatched_role`/`new_employee`.
 *
 * Gemini's role extraction is non-deterministic across runs (it sometimes
 * emits "Management", sometimes "Management / Floor", sometimes the section
 * header "SUPERVISORS"), so we seed every role label it has been observed to
 * produce. Matching is case/whitespace-insensitive (normalizeHeader), so the
 * exact casing doesn't matter.
 *
 * Idempotent: safe to re-run (upserts by unique name / email).
 *
 * Usage: npx tsx server/scripts/seed-gattopardo.ts
 */
import { prisma } from '../src/lib/prisma.js';

const LOCATION_ID = 'seed-location';
const ORG_ID = 'seed-org';

// Every role label Gemini has been observed to emit for this roster.
const ROLE_NAMES = [
  'Management',
  'Management / Floor',
  'Staff',
  'Floor Staff',
  'Supervisor',
  'SUPERVISORS',
  'Head Waiter',
  'HEAD WAITERS',
  'Waiter',
  'WAITERS',
  'Runner',
  'RUNNERS',
];

// Employee -> role (canonical). Each employee is created under their primary
// role; the section-header role variants above exist so a row that Gemini
// labels "SUPERVISORS" still resolves to a real role.
const STAFF: { name: string; role: string }[] = [
  { name: 'Kalim', role: 'Management' },
  { name: 'Nemur', role: 'Management' },
  { name: 'Rumur', role: 'Management' },
  { name: 'Karen', role: 'Management' },
  { name: 'Ruren', role: 'Supervisor' },
  { name: 'Mibru', role: 'Supervisor' },
  { name: 'Kapix', role: 'Supervisor' },
  { name: 'Nezon', role: 'Head Waiter' },
  { name: 'Nelim', role: 'Head Waiter' },
  { name: 'Lomur', role: 'Head Waiter' },
  { name: 'Nedak', role: 'Head Waiter' },
  { name: 'Lodak', role: 'Waiter' },
  { name: 'Rudak', role: 'Waiter' },
  { name: 'Kadak', role: 'Runner' },
  { name: 'Lozon', role: 'Runner' },
  { name: 'Nevos', role: 'Runner' },
  { name: 'Nepix', role: 'Runner' },
  { name: 'Mivos', role: 'Runner' },
  { name: 'Mipix', role: 'Runner' },
  { name: 'Ruvos', role: 'Runner' },
  { name: 'Rugal', role: 'Runner' },
];

async function main() {
  const org = await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: 'ShiftSync Test Restaurant Group' },
  });

  const location = await prisma.location.upsert({
    where: { id: LOCATION_ID },
    update: {},
    create: {
      id: LOCATION_ID,
      organizationId: org.id,
      name: 'Downtown Dubai Test Venue',
      emirate: 'Dubai',
    },
  });

  // Create all role labels.
  const roles = await Promise.all(
    ROLE_NAMES.map((name) =>
      prisma.role.upsert({
        where: { locationId_name: { locationId: location.id, name } },
        update: {},
        create: { locationId: location.id, name },
      }),
    ),
  );
  const roleIdByName = new Map(roles.map((r) => [r.name, r.id]));

  // Create each staff member under their canonical role.
  const users = [];
  for (const s of STAFF) {
    const roleId = roleIdByName.get(s.role)!;
    const email = `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@gattopardo.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { roleId, fullName: s.name, locationId: location.id },
      create: {
        locationId: location.id,
        roleId,
        fullName: s.name,
        email,
        baseMonthlySalary: 4000,
      },
    });
    users.push(user);
  }

  console.log('Seeded Gattopardo staff for', location.id);
  console.log('  roles:', roles.map((r) => r.name).join(', '));
  console.log('  staff:', users.map((u) => u.fullName).join(', '));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
