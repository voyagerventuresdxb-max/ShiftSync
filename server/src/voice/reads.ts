import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { formatVenueTime } from '../lib/venueTime.js';
import { combineDateAndTime } from '../parsing/normalize.js';
import { isRealDate } from '../lib/shiftRules.js';
import type { ReadAnswer, ReadIntent, ReadIntentType } from './intentSchema.js';
import { VOICE_HORIZON_DAYS, type VenueContext } from './context.js';

/**
 * The read tools, answered by the SERVER from the caller's own venue's records. The model only
 * picks the tool; it never sees these results, and everything stored (names, notes, announcement
 * text) is returned as plain data for the app to render as text.
 *
 * Who sees what mirrors the REST reads, and is never wider:
 *  - who is working / who is in a section: managers and owners see the venue's rota, drafts
 *    marked; staff see only PUBLISHED shifts and section assignments (what the rota shows them
 *    once it is published, and what the venue's kiosk screen shows);
 *  - pending requests: managers see the venue's pending swaps and upcoming time off; staff only
 *    their own (swaps they asked for or were asked to cover, and their own marks);
 *  - recent announcements and shout-outs: the venue's own, like GET /api/announcements and
 *    /api/shoutouts;
 *  - my schedule: the caller's own shifts only, like GET /api/my-shifts.
 * Never another venue: every query is scoped by the caller's session venue.
 */
export interface Caller {
  id: string;
  systemRole: SystemRole;
  locationId: string;
}

export interface ReadArgs {
  day?: string | null;
  period?: 'AM' | 'PM' | null;
  week?: string | null;
  /** WHO_IN_SECTION: the section, already resolved to this venue's section. */
  section?: { id: string; label: string } | null;
}

/** "Thursday 8 October 2026". */
export function longDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
/** "Thu 8 Oct". */
function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const utcDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isManager = (c: Caller) => c.systemRole !== 'STAFF';

function read(intent: ReadIntentType, answer: ReadAnswer, confidence: number, summary?: string): ReadIntent {
  const n = answer.items.length;
  return { intent, answer, confidence, summary: summary ?? (n ? `${answer.title}: ${n} ${n === 1 ? 'entry' : 'entries'}.` : answer.emptyText) };
}

/**
 * The window a service period covers, as instants: morning service 05:00–14:00, evening service
 * 17:00 to 04:00 the next morning. A shift is in the period when it overlaps it.
 */
function periodWindow(day: string, period: 'AM' | 'PM', timezone: string): { from: Date; to: Date } {
  return period === 'AM'
    ? { from: combineDateAndTime(day, '05:00', timezone), to: combineDateAndTime(day, '14:00', timezone) }
    : { from: combineDateAndTime(day, '17:00', timezone), to: combineDateAndTime(day, '04:00', timezone, true) };
}

const PERIOD_WORD = { AM: 'in the morning', PM: 'in the evening' } as const;

export async function whoIsWorking(caller: Caller, ctx: VenueContext, args: ReadArgs, confidence: number): Promise<ReadIntent> {
  const day = args.day && isRealDate(args.day) ? args.day : ctx.today;
  const period = args.period ?? null;
  const window = period ? periodWindow(day, period, ctx.timezone) : null;
  const shifts = await prisma.shift.findMany({
    where: {
      locationId: caller.locationId,
      date: utcDay(day),
      status: isManager(caller) ? { not: 'CANCELLED' } : 'PUBLISHED',
      ...(window ? { startTime: { lt: window.to }, endTime: { gt: window.from } } : {}),
    },
    include: { role: { select: { name: true } }, assignee: { select: { fullName: true } } },
    orderBy: [{ startTime: 'asc' }],
    take: 100,
  });
  const when = period === 'PM' && day === ctx.today ? 'tonight' : period ? PERIOD_WORD[period] : day === ctx.today ? 'today' : '';
  const title = `Working${when ? ` ${when}` : ''} — ${longDay(day)}`;
  return read(
    'WHO_IS_WORKING',
    {
      title,
      items: shifts.map((s) => ({
        primary: s.assignee?.fullName ?? 'Open shift',
        secondary: `${formatVenueTime(s.startTime, ctx.timezone)}–${formatVenueTime(s.endTime, ctx.timezone)} · ${s.role.name}`,
        ...(s.status === 'DRAFT' ? { tertiary: 'Draft (not published yet)' } : {}),
      })),
      emptyText: isManager(caller) ? `Nobody is on the rota${when ? ` ${when}` : ''} for ${longDay(day)}.` : `Nobody is on the published rota${when ? ` ${when}` : ''} for ${longDay(day)}.`,
    },
    confidence,
  );
}

export async function whoInSection(caller: Caller, ctx: VenueContext, args: ReadArgs, confidence: number): Promise<ReadIntent> {
  const section = args.section!;
  const day = args.day && isRealDate(args.day) ? args.day : ctx.today;
  const period = args.period ?? null;
  const rows = await prisma.sectionAssignment.findMany({
    where: {
      sectionId: section.id,
      section: { locationId: caller.locationId },
      shiftDate: utcDay(day),
      ...(period ? { period } : {}),
      ...(isManager(caller) ? {} : { status: 'PUBLISHED' as const }),
    },
    include: { staff: { select: { fullName: true } } },
    orderBy: [{ period: 'asc' }, { createdAt: 'asc' }],
    take: 100,
  });
  const when = period ? `, ${period === 'AM' ? 'morning' : 'evening'}` : '';
  return read(
    'WHO_IN_SECTION',
    {
      title: `${section.label} — ${longDay(day)}${when}`,
      items: rows.map((a) => ({
        primary: a.staff.fullName,
        secondary: a.period === 'AM' ? 'Morning' : 'Evening',
        ...(a.dutyLabel ? { tertiary: a.dutyLabel } : a.status === 'DRAFT' ? { tertiary: 'Draft (not published yet)' } : {}),
      })),
      emptyText: `Nobody is assigned to ${section.label} on ${longDay(day)}${when}.`,
    },
    confidence,
  );
}

export async function pendingRequests(caller: Caller, ctx: VenueContext, confidence: number): Promise<ReadIntent> {
  const own = !isManager(caller);
  const swaps = await prisma.shiftSwapRequest.findMany({
    where: {
      status: 'PENDING',
      shift: { locationId: caller.locationId },
      ...(own ? { OR: [{ requestedById: caller.id }, { targetUserId: caller.id }] } : {}),
    },
    include: {
      requestedBy: { select: { fullName: true } },
      targetUser: { select: { fullName: true } },
      shift: { select: { date: true, startTime: true, endTime: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  // Time off is an availability mark (UNAVAILABLE / PREFERRED_OFF) from today through the horizon.
  const marks = await prisma.availabilityMark.findMany({
    where: {
      date: { gte: utcDay(ctx.today), lt: utcDay(addDays(ctx.today, VOICE_HORIZON_DAYS)) },
      user: { locationId: caller.locationId, isActive: true },
      ...(own ? { userId: caller.id } : {}),
    },
    include: { user: { select: { fullName: true } } },
    orderBy: [{ date: 'asc' }],
    take: 100,
  });
  const items = [
    ...swaps.map((r) => {
      const d = r.shift.date.toISOString().slice(0, 10);
      return {
        primary: r.targetUser ? `${r.requestedBy.fullName} asks ${r.targetUser.fullName} to cover` : `${r.requestedBy.fullName} asks for cover`,
        secondary: `${shortDay(d)} · ${formatVenueTime(r.shift.startTime, ctx.timezone)}–${formatVenueTime(r.shift.endTime, ctx.timezone)}`,
        tertiary: 'Swap request, waiting for a manager',
      };
    }),
    ...marks.map((m) => ({
      primary: `${m.user.fullName} — ${m.type === 'UNAVAILABLE' ? 'unavailable' : 'prefers the day off'}`,
      secondary: shortDay(m.date.toISOString().slice(0, 10)),
      ...(m.note ? { tertiary: m.note } : {}),
    })),
  ];
  return read(
    'PENDING_REQUESTS',
    {
      title: own ? `Your pending swaps and time off — next ${VOICE_HORIZON_DAYS} days` : `Pending swap requests and time off — next ${VOICE_HORIZON_DAYS} days`,
      items,
      emptyText: own ? 'You have no pending swap requests or time off coming up.' : 'No pending swap requests or time off coming up.',
    },
    confidence,
  );
}

export async function recentAnnouncements(caller: Caller, _ctx: VenueContext, confidence: number): Promise<ReadIntent> {
  const [announcements, shoutouts] = await Promise.all([
    prisma.announcement.findMany({
      where: { locationId: caller.locationId },
      include: { author: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.shoutout.findMany({
      where: { locationId: caller.locationId },
      include: { employee: { select: { fullName: true } }, author: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 3,
    }),
  ]);
  const when = (d: Date) => shortDay(d.toISOString().slice(0, 10));
  return read(
    'RECENT_ANNOUNCEMENTS',
    {
      title: 'Recent announcements and shout-outs',
      items: [
        ...announcements.map((a) => ({ primary: a.body, secondary: `${a.author?.fullName ?? 'A manager'} · ${when(a.createdAt)}`, tertiary: 'Announcement' })),
        ...shoutouts.map((s) => ({ primary: s.note, secondary: `For ${s.employee.fullName}${s.author ? `, from ${s.author.fullName}` : ''} · ${when(s.createdAt)}`, tertiary: 'Shout-out' })),
      ],
      emptyText: 'There are no announcements or shout-outs yet.',
    },
    confidence,
  );
}

/** The caller's own shifts: one day, one week, or the next 14 days. */
export async function mySchedule(caller: Caller, ctx: VenueContext, args: ReadArgs, confidence: number): Promise<ReadIntent> {
  let from = ctx.today;
  let to = addDays(ctx.today, VOICE_HORIZON_DAYS);
  let title = `Your shifts — next ${VOICE_HORIZON_DAYS} days`;
  let empty = `You have no shifts in the next ${VOICE_HORIZON_DAYS} days.`;
  if (args.day && isRealDate(args.day)) {
    from = args.day;
    to = addDays(args.day, 1);
    title = `Your shifts — ${longDay(args.day)}`;
    empty = `You have no shift on ${longDay(args.day)}.`;
  } else if (args.week && isRealDate(args.week)) {
    from = args.week < ctx.today ? ctx.today : args.week;
    to = addDays(args.week, 7);
    title = `Your shifts — week of ${longDay(args.week)}`;
    empty = `You have no shifts in the week of ${longDay(args.week)}.`;
  }
  const shifts = await prisma.shift.findMany({
    where: { userId: caller.id, locationId: caller.locationId, date: { gte: utcDay(from), lt: utcDay(to) }, status: { not: 'CANCELLED' } },
    include: { role: { select: { name: true } } },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    take: 30,
  });
  const items = shifts.map((s) => ({
    primary: longDay(s.date.toISOString().slice(0, 10)),
    secondary: `${formatVenueTime(s.startTime, ctx.timezone)}–${formatVenueTime(s.endTime, ctx.timezone)} · ${s.role.name}`,
  }));
  const summary = items.length
    ? `You have ${items.length} shift${items.length === 1 ? '' : 's'}: ${items.slice(0, 3).map((i) => `${i.primary}, ${i.secondary.split(' · ')[0]}`).join('; ')}${items.length > 3 ? '; …' : ''}.`
    : empty;
  return read('QUERY_MY_SCHEDULE', { title, items, emptyText: empty }, confidence, summary);
}
