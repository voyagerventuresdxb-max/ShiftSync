/**
 * Demo venue for a manager walkthrough on a real phone: a realistic Dubai
 * fine-dining venue with roles, a staff roster, floor-plan sections, the
 * current week published (so My Shifts and the rota have something to show),
 * an announcement, a shoutout and one PENDING join request for the Pending
 * Approvals demo.
 *
 *   npm run db:seed:demo -- --phones=<owner>,<staff>,<applicant>
 *
 * The three phone numbers are the ones YOU will sign in / join with on the
 * demo phones (they must also be in ECHO_ALLOWED_PHONES while there is no SMS
 * provider). They are never stored in this file: pass them on the command
 * line each time. Idempotent: every row has a fixed `demo-*` id or a unique
 * key, so re-running refreshes the week instead of duplicating it.
 *
 * LOCAL ONLY. The script refuses to run unless DATABASE_URL's host is
 * localhost / 127.0.0.1 (same guard as the test-venue cleanup script), and it
 * has no override flag: the demo data belongs on a laptop or a dedicated demo
 * database, never on production.
 */
import { checkDatabaseHost } from '../src/lib/testVenueCleanup.js';
import { toE164 } from '../src/lib/phone.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { combineDateAndTime } from '../src/parsing/normalize.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/** The Monday (YYYY-MM-DD) of the week containing `now` in the venue's timezone, and the `Shift.date` range for it. */
function currentVenueWeek(tz: string): { weekStart: string; start: Date; end: Date } {
  const local = dayjs().tz(tz);
  const weekStart = local.add(local.day() === 0 ? -6 : 1 - local.day(), 'day').format('YYYY-MM-DD');
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { weekStart, start, end };
}

const TIMEZONE = 'Asia/Dubai';
const ORG_ID = 'demo-org';
const LOCATION_ID = 'demo-location';

function usage(message: string): never {
  console.error(`\n[seed-demo-venue] ${message}\n\nUsage: npm run db:seed:demo -- --phones=<owner>,<staff>,<applicant>\n  three mobile numbers in any format toE164 accepts (owner signs in as the manager,\n  staff signs in on the second phone, applicant is the pending join request).\n`);
  process.exit(1);
}

const hostCheck = checkDatabaseHost(process.env.DATABASE_URL);
if (!hostCheck.ok) usage(hostCheck.reason);
if (hostCheck.production) usage('This script never runs against production.');

const phonesArg = process.argv.find((a) => a.startsWith('--phones='))?.slice('--phones='.length) ?? '';
const phones = phonesArg.split(',').map((p) => toE164(p.trim()));
if (phones.length !== 3 || phones.some((p) => !p)) usage('--phones needs exactly three valid mobile numbers, comma-separated.');
const [ownerPhone, staffPhone, applicantPhone] = phones as [string, string, string];
if (new Set(phones).size !== 3) usage('the three numbers must be different.');

// Import after the host check: constructing the client is what connects.
const { prisma } = await import('../src/lib/prisma.js');

const STAFF: { id: string; fullName: string; role: string; jobTitle: string; language: string }[] = [
  { id: 'demo-user-layla', fullName: 'Layla Haddad', role: 'Supervisor', jobTitle: 'Floor Supervisor', language: 'ar' },
  { id: 'demo-user-omar', fullName: 'Omar Farouk', role: 'Bartender', jobTitle: 'Head Bartender', language: 'ar' },
  { id: 'demo-user-priya', fullName: 'Priya Nair', role: 'Server', jobTitle: 'Senior Server', language: 'ml' },
  { id: 'demo-user-chen', fullName: 'Chen Wei', role: 'Server', jobTitle: 'Server', language: 'zh' },
  { id: 'demo-user-yusuf', fullName: 'Yusuf Adeyemi', role: 'Runner', jobTitle: 'Runner', language: 'en' },
  { id: 'demo-user-ana', fullName: 'Ana Reyes', role: 'Host', jobTitle: 'Host', language: 'tl' },
  { id: 'demo-user-marco', fullName: 'Marco Bianchi', role: 'Chef', jobTitle: 'Chef de Partie', language: 'it' },
];

/** Mon..Sun, "start-end" in venue wall-clock, or null for a day off. */
const WEEK: Record<string, (string | null)[]> = {
  'demo-user-layla': ['12:00-20:00', '12:00-20:00', null, '15:00-23:30', '15:00-23:30', '15:00-23:30', null],
  'demo-user-omar': ['17:00-01:00', null, '17:00-01:00', '17:00-01:00', '17:00-01:00', '17:00-01:00', null],
  'demo-user-priya': ['11:00-15:00', '11:00-15:00', '11:00-15:00', null, '18:00-23:00', '18:00-23:00', '18:00-23:00'],
  'demo-user-chen': [null, '18:00-23:00', '18:00-23:00', '18:00-23:00', '18:00-23:00', null, '12:00-16:00'],
  'demo-user-yusuf': ['16:00-23:00', '16:00-23:00', null, null, '16:00-23:00', '16:00-23:00', '16:00-23:00'],
  'demo-user-ana': ['11:30-16:00', null, '11:30-16:00', '18:00-23:00', '18:00-23:00', '18:00-23:00', null],
  'demo-user-marco': ['10:00-15:00', '10:00-15:00', '10:00-15:00', '10:00-15:00', null, null, '10:00-15:00'],
};

async function main() {
  await prisma.organization.upsert({ where: { id: ORG_ID }, update: {}, create: { id: ORG_ID, name: 'Sefarina Hospitality (demo)' } });
  const location = await prisma.location.upsert({
    where: { id: LOCATION_ID },
    update: { name: 'Sefarina DIFC (demo)', emirate: 'Dubai', venueType: 'Fine Dining', timezone: TIMEZONE },
    create: { id: LOCATION_ID, organizationId: ORG_ID, name: 'Sefarina DIFC (demo)', emirate: 'Dubai', venueType: 'Fine Dining', timezone: TIMEZONE },
  });

  const roleNames = ['Supervisor', 'Bartender', 'Server', 'Runner', 'Host', 'Chef'];
  const roles = new Map<string, string>();
  for (const name of roleNames) {
    const role = await prisma.role.upsert({ where: { locationId_name: { locationId: location.id, name } }, update: { isActive: true }, create: { locationId: location.id, name } });
    roles.set(name, role.id);
  }

  // The owner (you) and the staffer whose phone you'll sign in with on the second device.
  await prisma.user.upsert({
    where: { id: 'demo-user-owner' },
    update: { phone: ownerPhone, isActive: true },
    create: { id: 'demo-user-owner', locationId: location.id, fullName: 'Demo Owner', systemRole: 'OWNER', phone: ownerPhone, jobTitle: 'General Manager', roleId: roles.get('Supervisor') },
  });
  for (const s of STAFF) {
    await prisma.user.upsert({
      where: { id: s.id },
      update: { fullName: s.fullName, roleId: roles.get(s.role), jobTitle: s.jobTitle, preferredLanguage: s.language, isActive: true, ...(s.id === 'demo-user-priya' ? { phone: staffPhone } : {}) },
      create: {
        id: s.id,
        locationId: location.id,
        fullName: s.fullName,
        systemRole: 'STAFF',
        roleId: roles.get(s.role),
        jobTitle: s.jobTitle,
        preferredLanguage: s.language,
        hiredAt: new Date('2025-03-01T00:00:00.000Z'),
        ...(s.id === 'demo-user-priya' ? { phone: staffPhone } : {}),
      },
    });
  }

  // Floor plan + sections (pins). No image file is needed for the section list and assignments.
  const plan = await prisma.floorPlanImage.upsert({
    where: { id: 'demo-floor-plan' },
    update: {},
    create: { id: 'demo-floor-plan', locationId: location.id, fileUrl: '/uploads/floor-plans/demo-floor-plan.png', originalName: 'demo-floor-plan.png', mimeType: 'image/png' },
  });
  const sections = [
    { id: 'demo-section-terrace', label: 'Terrace', pinX: 0.2, pinY: 0.3, paxCapacity: 24, notes: 'Shade after 17:00' },
    { id: 'demo-section-main', label: 'Main Dining', pinX: 0.55, pinY: 0.5, paxCapacity: 48, notes: null },
    { id: 'demo-section-bar', label: 'Bar', pinX: 0.85, pinY: 0.35, paxCapacity: 16, notes: 'Cocktail list changes Thursday' },
    { id: 'demo-section-private', label: 'Private Room', pinX: 0.8, pinY: 0.8, paxCapacity: 12, notes: 'VIP only' },
  ];
  for (const [i, sec] of sections.entries()) {
    await prisma.floorSection.upsert({
      where: { id: sec.id },
      update: { label: sec.label, pinX: sec.pinX, pinY: sec.pinY, paxCapacity: sec.paxCapacity, notes: sec.notes, sortOrder: i },
      create: { id: sec.id, locationId: location.id, floorPlanImageId: plan.id, label: sec.label, pinX: sec.pinX, pinY: sec.pinY, paxCapacity: sec.paxCapacity, notes: sec.notes, sortOrder: i },
    });
  }

  // This week's rota, published. Re-running replaces this week's demo shifts.
  const { weekStart, start, end } = currentVenueWeek(TIMEZONE);
  await prisma.shift.deleteMany({ where: { locationId: location.id, date: { gte: start, lt: end } } });
  let shiftCount = 0;
  for (const s of STAFF) {
    const days = WEEK[s.id]!;
    for (let d = 0; d < 7; d++) {
      const slot = days[d];
      if (!slot) continue;
      const [startHm, endHm] = slot.split('-') as [string, string];
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + d);
      const iso = date.toISOString().slice(0, 10);
      const overnight = endHm <= startHm;
      await prisma.shift.create({
        data: {
          locationId: location.id,
          roleId: roles.get(s.role)!,
          userId: s.id,
          createdById: 'demo-user-owner',
          date,
          startTime: combineDateAndTime(iso, startHm, TIMEZONE),
          endTime: combineDateAndTime(iso, endHm, TIMEZONE, overnight),
          status: 'PUBLISHED',
        },
      });
      shiftCount++;
    }
  }
  const publishedAt = new Date();
  await prisma.rotaPublish.upsert({
    where: { locationId_weekStart: { locationId: location.id, weekStart: start } },
    update: { publishedAt, publishedById: 'demo-user-owner', notifiedCount: STAFF.length },
    create: { locationId: location.id, weekStart: start, publishedAt, publishedById: 'demo-user-owner', notifiedCount: STAFF.length },
  });

  // Something on Home: an announcement and a shoutout.
  await prisma.announcement.upsert({
    where: { id: 'demo-announcement' },
    update: {},
    create: { id: 'demo-announcement', locationId: location.id, authorId: 'demo-user-owner', body: 'Friday brunch is fully booked — 180 covers. Pre-shift briefing at 11:00 on the terrace.' },
  });
  await prisma.shoutout.upsert({
    where: { id: 'demo-shoutout' },
    update: {},
    create: { id: 'demo-shoutout', locationId: location.id, authorId: 'demo-user-owner', employeeId: 'demo-user-omar', note: 'Omar turned a complaint on table 12 into a 5-star review. Thank you.' },
  });

  // One pending join request, for the Pending Approvals demo (the applicant phone joins again later).
  await prisma.joinRequest.deleteMany({ where: { locationId: location.id, phone: applicantPhone, status: 'PENDING' } });
  await prisma.joinRequest.create({ data: { locationId: location.id, phone: applicantPhone, fullName: 'Sara Nour', status: 'PENDING' } });

  console.log(`
[seed-demo-venue] ready (${hostCheck.host})
  venue      : Sefarina DIFC (demo)  (${location.id})
  owner      : Demo Owner — sign in on the manager phone with the first number you passed
  staff      : Priya Nair — sign in on the staff phone with the second number
  applicant  : Sara Nour — PENDING in Pending Approvals (the third number)
  week       : ${weekStart} published, ${shiftCount} shifts across ${STAFF.length} people
  sections   : ${sections.map((s) => s.label).join(', ')}
  reminder   : the three numbers must be in ECHO_ALLOWED_PHONES (no SMS yet); see docs/pilot-checklist.md
`);
}

main()
  .catch((err) => {
    console.error('[seed-demo-venue] failed', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
