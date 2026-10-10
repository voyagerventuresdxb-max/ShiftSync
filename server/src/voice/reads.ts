import type { SystemRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { formatVenueTime } from '../lib/venueTime.js';
import { isRealDate } from '../lib/shiftRules.js';
import { getWeekDoc, type WeekViewer } from '../lib/actions/weekActions.js';
import { addDays, mondayOf, type IsoDate, type WeekDocDto } from '../../../shared/rotaWeek.js';
import type { ParsedIntent, ReadAnswer, ReadIntent, ReadIntentType } from './intentSchema.js';
import { VOICE_HORIZON_DAYS, type VenueContext } from './context.js';
import { countWord, coverageWords, longDay, myScheduleWords, shortDay, whoIsOffWords, whoIsWorkingWords } from './readWords.js';

/**
 * The read tools, answered by the SERVER from the caller's own venue's records at request time
 * (nothing is cached: a question asked one second after a publish hears the published week). The
 * model only picks the tool; it never sees these results, and everything stored (names, notes,
 * announcement text) is returned as plain data for the app to render as text.
 *
 * The rota reads (who is working, who is off, coverage, my schedule) go through the week document
 * (lib/actions/weekActions.ts `getWeekDoc`) with the caller as the viewer, so what voice says is
 * exactly what the grid shows that person: staff hear PUBLISHED shifts and leave only (their own
 * time-off requests only); managers and owners hear drafts too. `summary` is the spoken answer
 * (Design board E, "Voice reads"); `answer.items` is the same answer as rows for the app.
 *
 * The other reads mirror the REST reads and are never wider:
 *  - who is in a section: managers see drafts, staff only PUBLISHED assignments;
 *  - pending requests: managers see the venue's pending time off, swaps and availability marks;
 *    staff only their own;
 *  - recent announcements and shout-outs: the venue's own, like GET /api/announcements.
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
  /** COVERAGE: a department as said ("bar"), looked up among the venue's departments. */
  department?: string | null;
}

const utcDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const isManager = (c: Caller) => c.systemRole !== 'STAFF';

function read(intent: ReadIntentType, answer: ReadAnswer, confidence: number, summary?: string): ReadIntent {
  const n = answer.items.length;
  return { intent, answer, confidence, summary: summary ?? (n ? `${answer.title}: ${n} ${n === 1 ? 'entry' : 'entries'}.` : answer.emptyText) };
}

// ---------------------------------------------------------------------------
// The week as the caller may see it
// ---------------------------------------------------------------------------

/** The grid's own visibility rules: OWNER/MANAGER see drafts, everyone else what staff see. */
function viewerOf(caller: Caller): WeekViewer {
  return caller.systemRole === 'OWNER' || caller.systemRole === 'MANAGER' ? { role: caller.systemRole, userId: caller.id } : { role: 'STAFF', userId: caller.id };
}

async function weekOf(caller: Caller, day: IsoDate, viewer: WeekViewer = viewerOf(caller)): Promise<WeekDocDto> {
  return getWeekDoc({ locationId: caller.locationId, weekStart: mondayOf(day), viewer });
}

async function roleNames(locationId: string): Promise<Map<string, string>> {
  const roles = await prisma.role.findMany({ where: { locationId }, select: { id: true, name: true } });
  return new Map(roles.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// The rota reads: the week as the caller may see it, then its words (readWords.ts)
// ---------------------------------------------------------------------------

/** "Wednesday 7 October: 8 people. Floor — Priya on Mid 11 to 20, …" */
export async function whoIsWorking(caller: Caller, ctx: VenueContext, args: ReadArgs, confidence: number): Promise<ReadIntent> {
  const day = args.day && isRealDate(args.day) ? args.day : ctx.today;
  const doc = await weekOf(caller, day);
  const w = whoIsWorkingWords(doc, { day, period: args.period ?? null, today: ctx.today, manager: isManager(caller), roles: await roleNames(caller.locationId) });
  return read('WHO_IS_WORKING', w.answer, confidence, w.summary);
}

/** "Thursday 8 October: Omar, Tariq and Hana are off. Mateo is on annual leave. …" */
export async function whoIsOff(caller: Caller, ctx: VenueContext, args: ReadArgs, confidence: number): Promise<ReadIntent> {
  const day = args.day && isRealDate(args.day) ? args.day : ctx.today;
  const w = whoIsOffWords(await weekOf(caller, day), { day, callerId: caller.id });
  return read('WHO_IS_OFF', w.answer, confidence, w.summary);
}

/** "Not yet — Bar needs one more on Saturday 10 October. …"; a department nobody has is asked again. */
export async function coverage(caller: Caller, ctx: VenueContext, args: ReadArgs, confidence: number): Promise<ParsedIntent> {
  const day = args.day && isRealDate(args.day) ? args.day : ctx.today;
  const w = coverageWords(await weekOf(caller, day), { day, department: args.department ?? null });
  if ('unknownDepartment' in w) {
    return { intent: 'UNRECOGNIZED', reason: 'Say the department as it is on the rota, or ask "is Saturday covered?".', summary: `I couldn't find a ${w.unknownDepartment} department at your venue.` };
  }
  return read('COVERAGE', w.answer, confidence, w.summary);
}

// ---------------------------------------------------------------------------
// WHO_IN_SECTION, PENDING_REQUESTS, RECENT_ANNOUNCEMENTS
// ---------------------------------------------------------------------------

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

/** "Thu 8 Oct" or "Thu 8 Oct to Sat 10 Oct". */
const dayRange = (a: string, b: string) => (a === b ? shortDay(a) : `${shortDay(a)} to ${shortDay(b)}`);

/**
 * Pending time-off requests (TimeOffRequest), swap requests and availability marks. "Two. Priya
 * asked for Thu 8 Oct off. Tariq asks Mei to cover Sun 11 Oct."
 */
export async function pendingRequests(caller: Caller, ctx: VenueContext, confidence: number): Promise<ReadIntent> {
  const own = !isManager(caller);
  const timeOff = await prisma.timeOffRequest.findMany({
    where: {
      status: 'PENDING',
      endDate: { gte: utcDay(ctx.today) },
      user: { locationId: caller.locationId, isActive: true },
      ...(own ? { userId: caller.id } : {}),
    },
    include: { user: { select: { fullName: true } } },
    orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    take: 50,
  });
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
  // Availability marks (UNAVAILABLE / PREFERRED_OFF) from today through the horizon.
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
  const who = (userId: string, fullName: string) => (userId === caller.id ? 'You' : fullName);
  const rows: { item: ReadAnswer['items'][number]; spoken: string }[] = [
    ...timeOff.map((r) => {
      const days = dayRange(toIso(r.startDate), toIso(r.endDate));
      return {
        item: { primary: `${r.user.fullName} asked for time off`, secondary: days, tertiary: r.reason ? `Time-off request, waiting for a manager · ${r.reason}` : 'Time-off request, waiting for a manager' },
        spoken: `${who(r.userId, r.user.fullName)} asked for ${days} off.`,
      };
    }),
    ...swaps.map((r) => {
      const d = toIso(r.shift.date);
      return {
        item: {
          primary: r.targetUser ? `${r.requestedBy.fullName} asks ${r.targetUser.fullName} to cover` : `${r.requestedBy.fullName} asks for cover`,
          secondary: `${shortDay(d)} · ${formatVenueTime(r.shift.startTime, ctx.timezone)}–${formatVenueTime(r.shift.endTime, ctx.timezone)}`,
          tertiary: 'Swap request, waiting for a manager',
        },
        spoken: r.targetUser
          ? `${who(r.requestedById, r.requestedBy.fullName)} ${r.requestedById === caller.id ? 'ask' : 'asks'} ${r.targetUserId === caller.id ? 'you' : r.targetUser.fullName} to cover ${shortDay(d)}.`
          : `${who(r.requestedById, r.requestedBy.fullName)} ${r.requestedById === caller.id ? 'ask' : 'asks'} for cover on ${shortDay(d)}.`,
      };
    }),
    ...marks.map((m) => {
      const d = shortDay(toIso(m.date));
      return {
        item: { primary: `${m.user.fullName} — ${m.type === 'UNAVAILABLE' ? 'unavailable' : 'prefers the day off'}`, secondary: d, ...(m.note ? { tertiary: m.note } : {}) },
        spoken:
          m.type === 'UNAVAILABLE'
            ? `${who(m.userId, m.user.fullName)} ${m.userId === caller.id ? 'are' : 'is'} unavailable on ${d}.`
            : `${who(m.userId, m.user.fullName)} would rather have ${d} off.`,
      };
    }),
  ];
  const emptyText = own ? 'You have no pending swap requests or time off coming up.' : 'No pending swap requests or time off coming up.';
  const shown = rows.slice(0, 5).map((r) => r.spoken);
  const summary = rows.length ? `${countWord(rows.length)}. ${shown.join(' ')}${rows.length > shown.length ? ` And ${rows.length - shown.length} more.` : ''}` : emptyText;
  return read(
    'PENDING_REQUESTS',
    {
      title: own ? `Your pending swaps and time off — next ${VOICE_HORIZON_DAYS} days` : `Pending swap requests and time off — next ${VOICE_HORIZON_DAYS} days`,
      items: rows.map((r) => r.item),
      emptyText,
    },
    confidence,
    summary,
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

// ---------------------------------------------------------------------------
// QUERY_MY_SCHEDULE
// ---------------------------------------------------------------------------

/**
 * The caller's own PUBLISHED week (what they were told; a manager's unpublished drafts are not
 * their schedule yet): one day, one week, or the next 14 days. "Mid on Monday, Wednesday and
 * Friday, 11 to 20. Evening on Saturday, 16 to 1 next day. Off Tuesday and Sunday."
 *
 * The board's "that one changed" is not said: once a week is published `editedSincePublish` is
 * false again, and the previous published version is not kept per shift, so there is nothing
 * true to say it changed against.
 */
export async function mySchedule(caller: Caller, ctx: VenueContext, args: ReadArgs, confidence: number): Promise<ReadIntent> {
  let from = ctx.today;
  let to = addDays(ctx.today, VOICE_HORIZON_DAYS);
  let mode: 'day' | 'week' | 'horizon' = 'horizon';
  let title = `Your shifts — next ${VOICE_HORIZON_DAYS} days`;
  let empty = `You have no shifts in the next ${VOICE_HORIZON_DAYS} days.`;
  if (args.day && isRealDate(args.day)) {
    mode = 'day';
    from = args.day;
    to = addDays(args.day, 1);
    title = `Your shifts — ${longDay(args.day)}`;
    empty = `You have no shift on ${longDay(args.day)}.`;
  } else if (args.week && isRealDate(args.week)) {
    mode = 'week';
    const monday = mondayOf(args.week);
    from = monday < ctx.today ? ctx.today : monday;
    to = addDays(monday, 7);
    title = `Your shifts — week of ${longDay(monday)}`;
    empty = `You have no shifts in the week of ${longDay(monday)}.`;
  }
  // Published only, whatever the caller's role: the staff view of each week touched.
  const viewer: WeekViewer = { role: 'STAFF', userId: caller.id };
  const days: IsoDate[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const docs = new Map<string, WeekDocDto>();
  for (const d of days) {
    const monday = mondayOf(d);
    if (!docs.has(monday)) docs.set(monday, await weekOf(caller, d, viewer));
  }
  const w = myScheduleWords([...docs.values()], { callerId: caller.id, mode, from, to, title, empty, roles: await roleNames(caller.locationId), horizonDays: VOICE_HORIZON_DAYS });
  return read('QUERY_MY_SCHEDULE', w.answer, confidence, w.summary);
}
