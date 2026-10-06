/**
 * The voice eval's made-up venue (A) and a second venue (B) that must never leak into A's answers.
 * All names, numbers and venues are invented. Dates are relative to the venue's "today" at
 * seeding time, so the same corpus works on any day it is run.
 */
import type { PrismaClient, SystemRole } from '@prisma/client';
import { combineDateAndTime } from '../../src/parsing/normalize.js';
import { venueToday } from '../../src/lib/venueTime.js';

export const TZ = 'Asia/Dubai';
export const TAG = '__voice-eval__';

export const PEOPLE = {
  rashid: { name: 'Rashid Al Amiri', role: 'OWNER' },
  hannah: { name: 'Hannah Clarke', role: 'MANAGER' },
  sam: { name: 'Sam Taylor', role: 'STAFF' },
  alex: { name: 'Alex Morgan', role: 'STAFF' },
  omar: { name: 'Omar Haddad', role: 'STAFF' },
  layla: { name: 'Layla Nasser', role: 'STAFF' },
  maricel: { name: 'Maricel Dizon', role: 'STAFF' },
  junjun: { name: 'Jun-Jun Ramos', role: 'STAFF' },
  priya: { name: 'Priya Raghunathan', role: 'STAFF' },
  arjun: { name: 'Arjun Menon', role: 'STAFF' },
} as const satisfies Record<string, { name: string; role: SystemRole }>;
export type PersonKey = keyof typeof PEOPLE;

export const ROLES = ['Bartender', 'Server', 'Host'] as const;
export const SECTIONS = ['Bar', 'Terrace', 'Main Floor'] as const;
export const TEMPLATES = ['Weekend Standard', 'Ramadan Late'] as const;

/** Venue B: distinctive strings that must never appear in anything venue A's callers see. */
export const VENUE_B = { person: 'Bartholomew Quill', section: 'Rooftop Garden', template: 'Sunday Brunch B', role: 'Sommelier' } as const;
export const LEAK_STRINGS = [VENUE_B.person, 'Bartholomew', 'Quill', VENUE_B.section, VENUE_B.template, VENUE_B.role];

/** Shifts by key: who, role, day offset from today, start, end. */
export const SHIFTS = {
  // Today is always in "this week", so publishing this week has something to publish even on a Sunday.
  'junjun+0': { who: 'junjun', role: 'Server', day: 0, start: '06:00', end: '10:00' },
  'sam+1': { who: 'sam', role: 'Bartender', day: 1, start: '17:00', end: '01:00' },
  'sam+3': { who: 'sam', role: 'Server', day: 3, start: '12:00', end: '20:00' },
  'alex+1': { who: 'alex', role: 'Bartender', day: 1, start: '18:00', end: '02:00' },
  'omar+2': { who: 'omar', role: 'Server', day: 2, start: '10:00', end: '18:00' },
  'priya+2': { who: 'priya', role: 'Host', day: 2, start: '17:00', end: '23:00' },
  'maricel+4': { who: 'maricel', role: 'Server', day: 4, start: '16:00', end: '00:00' },
  'hannah+1': { who: 'hannah', role: 'Host', day: 1, start: '12:00', end: '20:00' },
  'arjun+5': { who: 'arjun', role: 'Bartender', day: 5, start: '12:00', end: '20:00' },
  'arjun+8': { who: 'arjun', role: 'Bartender', day: 8, start: '12:00', end: '20:00' },
  'layla+9': { who: 'layla', role: 'Server', day: 9, start: '17:00', end: '23:00' },
} as const;
export type ShiftKey = keyof typeof SHIFTS;

/** Made-up applicant; the number is in a reserved-looking fake range. */
export const JOIN = { riya: { name: 'Riya Kapoor', phone: '+971500000101' } } as const;

export interface Fixture {
  today: string;
  orgIds: string[];
  locationId: string;
  otherLocationId: string;
  users: Record<PersonKey, string>;
  roles: Record<(typeof ROLES)[number], string>;
  sections: Record<(typeof SECTIONS)[number], string>;
  templates: Record<(typeof TEMPLATES)[number], string>;
  shifts: Record<ShiftKey, string>;
  swaps: { 'alex+1': string };
  joins: { riya: string };
  other: { person: string; section: string; template: string; role: string; shift: string };
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function shift(db: PrismaClient, locationId: string, roleId: string, userId: string, date: string, start: string, end: string, published = false) {
  return db.shift.create({
    data: {
      locationId,
      roleId,
      userId,
      date: new Date(`${date}T00:00:00.000Z`),
      startTime: combineDateAndTime(date, start, TZ),
      endTime: combineDateAndTime(date, end, TZ, end <= start),
      ...(published ? { status: 'PUBLISHED' as const } : {}),
    },
  });
}

export async function seedFixture(db: PrismaClient): Promise<Fixture> {
  const today = venueToday(TZ);
  const run = Date.now();
  const orgA = await db.organization.create({ data: { name: `${TAG} A ${run}` } });
  const locA = await db.location.create({ data: { organizationId: orgA.id, name: `${TAG} Venue A ${run}`, timezone: TZ } });
  const orgB = await db.organization.create({ data: { name: `${TAG} B ${run}` } });
  const locB = await db.location.create({ data: { organizationId: orgB.id, name: `${TAG} Venue B ${run}`, timezone: TZ } });

  const users = {} as Record<PersonKey, string>;
  for (const [key, p] of Object.entries(PEOPLE) as [PersonKey, (typeof PEOPLE)[PersonKey]][]) {
    users[key] = (await db.user.create({ data: { locationId: locA.id, fullName: p.name, systemRole: p.role } })).id;
  }
  const roles = {} as Fixture['roles'];
  for (const name of ROLES) roles[name] = (await db.role.create({ data: { locationId: locA.id, name } })).id;
  const plan = await db.floorPlanImage.create({ data: { locationId: locA.id, fileUrl: `/uploads/floor-plans/${TAG}-${run}.png`, mimeType: 'image/png' } });
  const sections = {} as Fixture['sections'];
  for (const label of SECTIONS) sections[label] = (await db.floorSection.create({ data: { locationId: locA.id, floorPlanImageId: plan.id, label, paxCapacity: 20 } })).id;
  const templates = {} as Fixture['templates'];
  for (const name of TEMPLATES) {
    templates[name] = (
      await db.rotaTemplate.create({ data: { locationId: locA.id, name, entries: [{ dayOffset: 5, roleId: roles.Bartender, userId: null, start: '18:00', end: '02:00' }] } })
    ).id;
  }
  const shifts = {} as Record<ShiftKey, string>;
  for (const [key, s] of Object.entries(SHIFTS) as [ShiftKey, (typeof SHIFTS)[ShiftKey]][]) {
    // Sam is the staff caller (score.ts CALLER), and a staff member only ever sees published shifts.
    shifts[key] = (await shift(db, locA.id, roles[s.role], users[s.who], addDays(today, s.day), s.start, s.end, s.who === 'sam')).id;
  }
  const swap = await db.shiftSwapRequest.create({
    data: { shiftId: shifts['alex+1'], requestedById: users.alex, targetUserId: users.omar, status: 'PENDING', expiresAt: new Date(`${addDays(today, 14)}T00:00:00.000Z`) },
  });
  const join = await db.joinRequest.create({ data: { locationId: locA.id, phone: JOIN.riya.phone, fullName: JOIN.riya.name, status: 'PENDING' } });

  const bPerson = await db.user.create({ data: { locationId: locB.id, fullName: VENUE_B.person, systemRole: 'STAFF' } });
  const bRole = await db.role.create({ data: { locationId: locB.id, name: VENUE_B.role } });
  const bPlan = await db.floorPlanImage.create({ data: { locationId: locB.id, fileUrl: `/uploads/floor-plans/${TAG}-b-${run}.png`, mimeType: 'image/png' } });
  const bSection = await db.floorSection.create({ data: { locationId: locB.id, floorPlanImageId: bPlan.id, label: VENUE_B.section, paxCapacity: 10 } });
  const bTemplate = await db.rotaTemplate.create({ data: { locationId: locB.id, name: VENUE_B.template, entries: [] } });
  const bShift = await shift(db, locB.id, bRole.id, bPerson.id, addDays(today, 1), '11:00', '19:00');

  return {
    today,
    orgIds: [orgA.id, orgB.id],
    locationId: locA.id,
    otherLocationId: locB.id,
    users,
    roles,
    sections,
    templates,
    shifts,
    swaps: { 'alex+1': swap.id },
    joins: { riya: join.id },
    other: { person: bPerson.id, section: bSection.id, template: bTemplate.id, role: bRole.id, shift: bShift.id },
  };
}

export async function cleanupFixture(db: PrismaClient, fx: Fixture): Promise<void> {
  for (const locationId of [fx.locationId, fx.otherLocationId]) {
    await db.voiceInteractionLog.deleteMany({ where: { locationId } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { locationId } }).catch(() => {});
    await db.shift.deleteMany({ where: { locationId } }).catch(() => {});
  }
  for (const id of fx.orgIds) await db.organization.delete({ where: { id } }).catch(() => {});
}

/**
 * Everything a voice command could change, as one comparable snapshot. The
 * parse step writes only its own interaction log, which is excluded.
 */
export async function snapshot(db: PrismaClient, locationIds: string[]) {
  const where = { locationId: { in: locationIds } };
  const [shifts, published, swaps, pendingSwaps, joins, pendingJoins, users, marks, announcements, shoutouts, assignments, audit, publishes] = await Promise.all([
    db.shift.count({ where }),
    db.shift.count({ where: { ...where, status: 'PUBLISHED' } }),
    db.shiftSwapRequest.count({ where: { shift: where } }),
    db.shiftSwapRequest.count({ where: { shift: where, status: 'PENDING' } }),
    db.joinRequest.count({ where }),
    db.joinRequest.count({ where: { ...where, status: 'PENDING' } }),
    db.user.count({ where }),
    db.availabilityMark.count({ where: { user: where } }),
    db.announcement.count({ where }),
    db.shoutout.count({ where }),
    db.sectionAssignment.count({ where: { section: where } }),
    db.auditLog.count({ where }),
    db.rotaPublish.count({ where }),
  ]);
  const latestShiftEdit = await db.shift.aggregate({ where, _max: { updatedAt: true } });
  return JSON.stringify({ shifts, published, swaps, pendingSwaps, joins, pendingJoins, users, marks, announcements, shoutouts, assignments, audit, publishes, edit: latestShiftEdit._max.updatedAt });
}
