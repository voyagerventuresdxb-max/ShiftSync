import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';
import { formatVenueTime, venueTimezoneFor } from '../lib/venueTime.js';

export const myShiftsRouter = Router();

/**
 * GET /api/my-shifts — session-resolved. Returns the next 5 upcoming
 * (today-or-later) shifts for the logged-in user, plus whether they have a
 * JoinRequest still pending review (relevant if they were auto-approved
 * later but the UI wants to show a residual banner — in practice this will
 * almost always be false for a real session, since only an approved/matched
 * identity ever reaches a session at all, but the field is included for a
 * accurate, honest "pending-approval banner" per the directive).
 */
myShiftsRouter.get('/', requireSession, async (req, res) => {
  try {
    const userId = req.user!.id;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const timezone = await venueTimezoneFor(req.user!.locationId);
    const shifts = await prisma.shift.findMany({
      // PUBLISHED only — a staff member never sees a draft (golden-path v0).
      where: { userId, date: { gte: today }, status: 'PUBLISHED' },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      take: 5,
      include: { role: { select: { name: true } } },
    });

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
        date: s.date.toISOString().slice(0, 10),
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        // Wall-clock times in the VENUE's timezone — the client renders these,
        // not the instants above, so a phone set to another timezone (or a
        // test browser in UTC) still shows the shift as it's actually worked.
        start: formatVenueTime(s.startTime, timezone),
        end: formatVenueTime(s.endTime, timezone),
        roleName: s.role.name,
        status: s.status,
      })),
    });
  } catch (err) {
    console.error('[myShifts.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading your shifts.' });
  }
});
