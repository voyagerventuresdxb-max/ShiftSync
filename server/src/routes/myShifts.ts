import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';
import { formatVenueTime, venueTimezoneFor, venueToday } from '../lib/venueTime.js';
import { shiftInstantsOf, toldShiftOf, toldSnapshotOf, type WeekSnapshot } from '../lib/actions/weekActions.js';
import { mondayOf, type MyShiftV2Fields } from '../../../shared/rotaWeek.js';

export const myShiftsRouter = Router();

/**
 * GET /api/my-shifts — session-resolved. Returns the next 5 upcoming
 * (today-or-later) shifts for the logged-in user, plus whether they have a
 * JoinRequest still pending review (relevant if they were auto-approved
 * later but the UI wants to show a residual banner — in practice this will
 * almost always be false for a real session, since only an approved/matched
 * identity ever reaches a session at all, but the field is included for a
 * accurate, honest "pending-approval banner" per the directive).
 *
 * Rota builder v2: published shifts only, each as the person was last TOLD it
 * (the week's published snapshot, see weekActions.toldShiftOf) — a draft, or
 * a manager's edit not yet published, never shows here; a shift reassigned to
 * someone else since publish still shows for its told owner until the next
 * publish tells them. Each item also carries MyShiftV2Fields (shared/
 * rotaWeek.ts): the shift type's name, both ranges of a split, the "+1"
 * marker and the staff-visible note.
 */
myShiftsRouter.get('/', requireSession, async (req, res) => {
  try {
    const userId = req.user!.id;
    // "Today" is the VENUE's calendar day, not the UTC date: between 00:00 and
    // 04:00 in Dubai the UTC date is still yesterday, which used to keep
    // yesterday's shifts in "upcoming".
    const timezone = await venueTimezoneFor(req.user!.locationId);
    const today = new Date(`${venueToday(timezone)}T00:00:00.000Z`);

    const locationId = req.user!.locationId;
    // Weeks from this one on that have been published: their snapshots name shifts told to this person even when
    // the live row has since been moved to someone else.
    const weeks = await prisma.rotaWeek.findMany({
      where: { locationId, weekStart: { gte: new Date(`${mondayOf(venueToday(timezone))}T00:00:00.000Z`) } },
      select: { weekStart: true, publishedSnapshot: true },
    });
    const toldIds: string[] = [];
    for (const w of weeks) {
      const snap = w.publishedSnapshot as unknown as WeekSnapshot | null;
      for (const [id, s] of Object.entries(snap?.shifts ?? {})) if (s.userId === userId) toldIds.push(id);
    }
    const rows = await prisma.shift.findMany({
      where: {
        locationId,
        date: { gte: today },
        status: { in: ['PUBLISHED', 'COMPLETED', 'CANCELLED'] },
        OR: [{ userId }, ...(toldIds.length > 0 ? [{ id: { in: toldIds } }] : [])],
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      take: 60,
      include: { role: { select: { name: true } }, shiftType: { select: { name: true } } },
    });
    const snapshots = new Map<string, WeekSnapshot | null>();
    const todayIso = venueToday(timezone);
    const shifts: (MyShiftV2Fields & { id: string; date: string; startTime: Date; endTime: Date; roleName: string; status: string })[] = [];
    for (const s of rows) {
      const weekStart = mondayOf(s.date.toISOString().slice(0, 10));
      if (!snapshots.has(weekStart)) snapshots.set(weekStart, await toldSnapshotOf(prisma, locationId, weekStart, timezone));
      const told = toldShiftOf(s, snapshots.get(weekStart) ?? null, timezone);
      if (!told || told.userId !== userId || told.date < todayIso) continue;
      // A told version of a shift since retyped names the type it was told with.
      const typeName =
        told.shiftTypeId === s.shiftTypeId ? (s.shiftType?.name ?? null) : told.shiftTypeId ? ((await prisma.shiftType.findUnique({ where: { id: told.shiftTypeId }, select: { name: true } }))?.name ?? null) : null;
      const { startTime, endTime } = shiftInstantsOf(told.date, told.ranges, timezone);
      shifts.push({
        id: s.id,
        date: told.date,
        startTime,
        endTime,
        roleName: s.role.name,
        status: s.status === 'CANCELLED' ? 'PUBLISHED' : s.status,
        shiftTypeName: typeName,
        ranges: told.ranges,
        endsNextDay: told.endsNextDay,
        note: told.note,
      });
    }
    shifts.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.getTime() - b.startTime.getTime());
    shifts.splice(5);

    // User.phone is optional. Prisma's `where` treats a key whose value is
    // `undefined` as "not present" rather than "match nothing" — so
    // `phone: undefined` would silently drop the phone filter entirely and
    // findFirst would return the first PENDING JoinRequest for ANY phone
    // number, not one scoped to this user. Skip the lookup outright when
    // there's no phone to scope by.
    const userPhone = req.user!.phone;
    const pendingJoinRequest = userPhone
      ? await prisma.joinRequest.findFirst({ where: { phone: userPhone, status: 'PENDING' } })
      : null;

    return res.status(200).json({
      pendingApproval: Boolean(pendingJoinRequest),
      shifts: shifts.map((s) => ({
        id: s.id,
        date: s.date,
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        // Venue wall-clock "HH:mm", so a phone in another timezone (or a
        // browser whose clock is wrong) still shows the venue's shift times.
        startLabel: formatVenueTime(s.startTime, timezone),
        endLabel: formatVenueTime(s.endTime, timezone),
        roleName: s.roleName,
        status: s.status,
        shiftTypeName: s.shiftTypeName,
        ranges: s.ranges,
        endsNextDay: s.endsNextDay,
        note: s.note,
      })),
    });
  } catch (err) {
    console.error('[myShifts.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading your shifts.' });
  }
});
