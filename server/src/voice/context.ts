import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { formatVenueTime, venueToday, venueTimezoneFor } from '../lib/venueTime.js';
import { buildVocabularyHint } from './transcribe.js';

/**
 * What the SERVER knows about the caller's venue while it resolves a voice command: the caller's
 * own venue only, loaded fresh for each command. None of this is sent to the model (prompts.ts
 * gets only today's date and `venueSpellingHint`); it is what the model's words as heard are
 * looked up in.
 */
export interface VenueContext {
  today: string; // YYYY-MM-DD, venue-local
  timezone: string;
  callerName: string;
  /** The caller's own upcoming shifts (today through 14 days). */
  callerShifts: { id: string; date: string; startTime: string; endTime: string; roleName?: string }[];
  /** Every active staff member at this location, for name resolution. */
  staffDirectory: { id: string; fullName: string; role?: string | null; roleId?: string | null }[];
  /** Manager-tier only: the pending decisions they could be asked to act on. */
  pendingSwapRequests?: {
    id: string;
    requesterId?: string;
    requesterName: string;
    coverName?: string | null;
    shiftLabel: string;
    shift?: { date: string; start: string; end: string };
  }[];
  /** Manager-tier only. Names only: an applicant's phone number is never loaded here. */
  pendingJoinRequests?: { id: string; fullName: string }[];
  /** Manager-tier only: every role at this venue (`isActive` false: removed, no new shifts). */
  roles?: { id: string; name: string; isActive?: boolean }[];
  /** Manager-tier only: every shift at this venue from today through +14 days. */
  weekShifts?: {
    id: string;
    roleName: string;
    roleId?: string;
    date: string;
    start: string;
    end: string;
    assigneeId?: string | null;
    assigneeName: string | null;
    status?: string;
  }[];
  /** Every floor section at this venue. */
  floorSections?: { id: string; label: string }[];
  /** Manager-tier only: every saved rota template at this venue. */
  rotaTemplates?: { id: string; name: string; entries?: unknown }[];
}

/** How far ahead a voice command looks for shifts, matching the 14-day calendar in the prompt. */
export const VOICE_HORIZON_DAYS = 14;

/** The bounded spelling hint for this venue: active staff display names and section names, nothing else. */
export async function venueSpellingHint(locationId: string): Promise<string> {
  const [staff, sections] = await Promise.all([
    prisma.user.findMany({ where: { locationId, isActive: true }, select: { fullName: true }, orderBy: { fullName: 'asc' } }),
    prisma.floorSection.findMany({ where: { locationId }, select: { label: true }, orderBy: { sortOrder: 'asc' } }),
  ]);
  return buildVocabularyHint(
    staff.map((s) => s.fullName),
    sections.map((s) => s.label),
  );
}

export async function buildContext(user: { id: string; systemRole: SystemRole; fullName: string; locationId: string }): Promise<VenueContext> {
  // Everything about "now" is in the VENUE's local zone, not UTC: a Dubai venue's 00:00-04:00 is
  // still the previous UTC day, so a UTC "today" would make "tomorrow" one day early.
  const timezone = await venueTimezoneFor(user.locationId);
  const today = venueToday(timezone);
  const staff = await prisma.user.findMany({
    where: { locationId: user.locationId, isActive: true },
    select: { id: true, fullName: true, roleId: true, role: { select: { name: true } } },
  });

  const startOfToday = new Date(`${today}T00:00:00.000Z`);
  const horizon = new Date(startOfToday);
  horizon.setUTCDate(horizon.getUTCDate() + VOICE_HORIZON_DAYS);

  const ctx: VenueContext = {
    today,
    timezone,
    callerName: user.fullName,
    callerShifts: [],
    staffDirectory: staff.map((s) => ({ id: s.id, fullName: s.fullName, role: s.role?.name ?? null, roleId: s.roleId })),
  };

  // `date` is stored as UTC-midnight-of-the-venue-local-day, so slicing it is the venue day; the
  // start/end INSTANTS go through the same `formatVenueTime` the REST shift DTO uses.
  const shifts = await prisma.shift.findMany({
    where: { userId: user.id, locationId: user.locationId, date: { gte: startOfToday, lt: horizon }, status: { not: 'CANCELLED' } },
    include: { role: { select: { name: true } } },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    take: 30,
  });
  ctx.callerShifts = shifts.map((s) => ({
    id: s.id,
    date: s.date.toISOString().slice(0, 10),
    startTime: formatVenueTime(s.startTime, timezone),
    endTime: formatVenueTime(s.endTime, timezone),
    roleName: s.role.name,
  }));

  ctx.floorSections = await prisma.floorSection.findMany({ where: { locationId: user.locationId }, select: { id: true, label: true }, orderBy: { sortOrder: 'asc' } });

  // Pending decisions, roles, templates and the venue's shifts are only loaded for manager-tier
  // callers: a STAFF command can never resolve to one of them.
  if (user.systemRole !== 'STAFF') {
    const pendingSwaps = await prisma.shiftSwapRequest.findMany({
      where: { status: 'PENDING', shift: { locationId: user.locationId } },
      include: { requestedBy: { select: { fullName: true } }, targetUser: { select: { fullName: true } }, shift: { select: { date: true, startTime: true, endTime: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    ctx.pendingSwapRequests = pendingSwaps.map((r) => {
      const shift = { date: r.shift.date.toISOString().slice(0, 10), start: formatVenueTime(r.shift.startTime, timezone), end: formatVenueTime(r.shift.endTime, timezone) };
      return { id: r.id, requesterId: r.requestedById, requesterName: r.requestedBy.fullName, coverName: r.targetUser?.fullName ?? null, shiftLabel: `${shift.date} ${shift.start}-${shift.end}`, shift };
    });

    const pendingJoins = await prisma.joinRequest.findMany({
      where: { locationId: user.locationId, status: 'PENDING' },
      select: { id: true, fullName: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    ctx.pendingJoinRequests = pendingJoins;

    ctx.roles = await prisma.role.findMany({ where: { locationId: user.locationId }, select: { id: true, name: true, isActive: true } });
    ctx.rotaTemplates = await prisma.rotaTemplate.findMany({ where: { locationId: user.locationId }, select: { id: true, name: true, entries: true } });

    const venueShifts = await prisma.shift.findMany({
      where: { locationId: user.locationId, date: { gte: startOfToday, lt: horizon }, status: { not: 'CANCELLED' } },
      include: { role: { select: { name: true } }, assignee: { select: { fullName: true } } },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      take: 500,
    });
    ctx.weekShifts = venueShifts.map((s) => ({
      id: s.id,
      roleName: s.role.name,
      roleId: s.roleId,
      date: s.date.toISOString().slice(0, 10),
      start: formatVenueTime(s.startTime, timezone),
      end: formatVenueTime(s.endTime, timezone),
      assigneeId: s.userId,
      assigneeName: s.assignee?.fullName ?? null,
      status: s.status,
    }));
  }

  return ctx;
}
