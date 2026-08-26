import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from '../parsing/normalize.js';
import { formatVenueTime } from '../lib/venueTime.js';

export const shiftsRouter = Router();

function shiftToDto(
  s: {
    id: string;
    date: Date;
    startTime: Date;
    endTime: Date;
    breakMinutes: number;
    status: string;
    managerNotes: string | null;
    sidework: string[];
    userId: string | null;
    roleId: string;
    updatedAt: Date;
    assignee: { id: string; fullName: string } | null;
    role: { id: string; name: string };
  },
  timezone: string,
) {
  return {
    id: s.id,
    employeeId: s.userId,
    employeeName: s.assignee?.fullName ?? null,
    roleId: s.roleId,
    roleName: s.role.name,
    date: s.date.toISOString().slice(0, 10),
    start: formatVenueTime(s.startTime, timezone),
    end: formatVenueTime(s.endTime, timezone),
    breakMinutes: s.breakMinutes,
    status: s.status === 'PUBLISHED' ? 'published' : 'draft',
    briefingNote: s.managerNotes,
    sidework: s.sidework,
    updatedAt: s.updatedAt.toISOString(),
  };
}

const SHIFT_INCLUDE = {
  assignee: { select: { id: true, fullName: true } },
  role: { select: { id: true, name: true } },
} as const;

async function venueTimezone(locationId: string): Promise<string> {
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  return location?.timezone || DEFAULT_VENUE_TIMEZONE;
}

/** GET /api/shifts/:locationId?weekStart=YYYY-MM-DD — the 7 days starting weekStart. */
shiftsRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    }
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const timezone = await venueTimezone(locationId);
    const shifts = await prisma.shift.findMany({
      where: { locationId, date: { gte: start, lt: end } },
      include: SHIFT_INCLUDE,
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
    return res.status(200).json({ shifts: shifts.map((s) => shiftToDto(s, timezone)) });
  } catch (err) {
    console.error('[shifts.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading shifts.' });
  }
});

/** POST /api/shifts — body: { locationId, roleId, userId?, date, start, end, breakMinutes?, briefingNote?, sidework?, createdById? } */
shiftsRouter.post('/', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const roleId = String(req.body?.roleId ?? '').trim();
    const userId = req.body?.userId ? String(req.body.userId).trim() : null;
    const date = String(req.body?.date ?? '').trim();
    const start = String(req.body?.start ?? '').trim();
    const end = String(req.body?.end ?? '').trim();
    const breakMinutes = Number(req.body?.breakMinutes ?? 0);
    const briefingNote = req.body?.briefingNote ? String(req.body.briefingNote).trim() : null;
    const sidework = Array.isArray(req.body?.sidework) ? req.body.sidework.map(String) : [];
    const createdById = req.body?.createdById ? String(req.body.createdById).trim() : null;

    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!roleId) return res.status(400).json({ error: 'roleId is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date is required, as YYYY-MM-DD.' });
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'start/end are required, as HH:MM.' });
    }

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.locationId !== locationId) return res.status(404).json({ error: `Role "${roleId}" not found.` });
    if (userId) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.locationId !== locationId) return res.status(404).json({ error: `Staff member "${userId}" not found.` });
    }

    const timezone = await venueTimezone(locationId);
    const overnight = end <= start;
    const startTime = combineDateAndTime(date, start, timezone);
    const endTime = combineDateAndTime(date, end, timezone, overnight);

    const created = await prisma.shift.create({
      data: { locationId, roleId, userId, createdById, date: new Date(`${date}T00:00:00.000Z`), startTime, endTime, breakMinutes, managerNotes: briefingNote, sidework, status: 'DRAFT' },
      include: SHIFT_INCLUDE,
    });
    await prisma.auditLog.create({
      data: { locationId, actorId: createdById, shiftId: created.id, action: 'SHIFT_CREATED', entityType: 'Shift', entityId: created.id },
    });
    return res.status(201).json({ shift: shiftToDto(created, timezone) });
  } catch (err) {
    console.error('[shifts.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while creating the shift.' });
  }
});

/** PATCH /api/shifts/:id — any subset of { roleId, userId, date, start, end, breakMinutes, briefingNote, sidework, actorId } */
shiftsRouter.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.shift.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Shift "${id}" not found.` });

    const timezone = await venueTimezone(existing.locationId);
    const data: Record<string, unknown> = {};
    if (req.body?.roleId !== undefined) data.roleId = String(req.body.roleId);
    if (req.body?.userId !== undefined) data.userId = req.body.userId ? String(req.body.userId) : null;
    if (req.body?.breakMinutes !== undefined) data.breakMinutes = Number(req.body.breakMinutes);
    if (req.body?.briefingNote !== undefined) data.managerNotes = req.body.briefingNote ? String(req.body.briefingNote) : null;
    if (req.body?.sidework !== undefined) data.sidework = Array.isArray(req.body.sidework) ? req.body.sidework.map(String) : [];

    const nextDate = req.body?.date !== undefined ? String(req.body.date) : existing.date.toISOString().slice(0, 10);
    const nextStart = req.body?.start !== undefined ? String(req.body.start) : formatVenueTime(existing.startTime, timezone);
    const nextEnd = req.body?.end !== undefined ? String(req.body.end) : formatVenueTime(existing.endTime, timezone);
    if (req.body?.date !== undefined || req.body?.start !== undefined || req.body?.end !== undefined) {
      const overnight = nextEnd <= nextStart;
      data.date = new Date(`${nextDate}T00:00:00.000Z`);
      data.startTime = combineDateAndTime(nextDate, nextStart, timezone);
      data.endTime = combineDateAndTime(nextDate, nextEnd, timezone, overnight);
    }

    const actorId = req.body?.actorId ? String(req.body.actorId) : null;
    const updated = await prisma.shift.update({ where: { id }, data, include: SHIFT_INCLUDE });
    await prisma.auditLog.create({
      data: { locationId: existing.locationId, actorId, shiftId: id, action: 'SHIFT_UPDATED', entityType: 'Shift', entityId: id },
    });
    return res.status(200).json({ shift: shiftToDto(updated, timezone) });
  } catch (err) {
    console.error('[shifts.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating the shift.' });
  }
});

/** DELETE /api/shifts/:id — body (optional): { actorId } */
shiftsRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.shift.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Shift "${id}" not found.` });
    const actorId = req.body?.actorId ? String(req.body.actorId) : null;
    await prisma.auditLog.create({
      data: { locationId: existing.locationId, actorId, shiftId: null, action: 'SHIFT_DELETED', entityType: 'Shift', entityId: id },
    });
    await prisma.shift.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    console.error('[shifts.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the shift.' });
  }
});

/** POST /api/shifts/bulk — body: { locationId, createdById?, shifts: [{ roleId, userId?, date, start, end, breakMinutes? }] } */
shiftsRouter.post('/bulk', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const createdById = req.body?.createdById ? String(req.body.createdById).trim() : null;
    const rows = Array.isArray(req.body?.shifts) ? req.body.shifts : [];
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (rows.length === 0) return res.status(400).json({ error: 'shifts must be a non-empty array.' });

    const timezone = await venueTimezone(locationId);
    const created = await prisma.$transaction(
      rows.map((r: { roleId: string; userId?: string | null; date: string; start: string; end: string; breakMinutes?: number }) => {
        const overnight = r.end <= r.start;
        return prisma.shift.create({
          data: {
            locationId,
            roleId: r.roleId,
            userId: r.userId ?? null,
            createdById,
            date: new Date(`${r.date}T00:00:00.000Z`),
            startTime: combineDateAndTime(r.date, r.start, timezone),
            endTime: combineDateAndTime(r.date, r.end, timezone, overnight),
            breakMinutes: r.breakMinutes ?? 0,
            status: 'DRAFT',
          },
          include: SHIFT_INCLUDE,
        });
      }),
    );
    return res.status(201).json({ shifts: created.map((s) => shiftToDto(s, timezone)), createdCount: created.length });
  } catch (err) {
    console.error('[shifts.bulk] failed', err);
    return res.status(500).json({ error: 'Unexpected error while bulk-creating shifts.' });
  }
});

/** POST /api/shifts/:locationId/publish — body: { weekStart, publishedById? } */
shiftsRouter.post('/:locationId/publish', async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStart = String(req.body?.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart is required, as YYYY-MM-DD.' });
    const publishedById = req.body?.publishedById ? String(req.body.publishedById).trim() : null;

    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const weekShifts = await prisma.shift.findMany({ where: { locationId, date: { gte: start, lt: end } } });
    if (weekShifts.length === 0) return res.status(400).json({ error: 'No shifts exist for this week yet.' });

    const notifiedCount = new Set(weekShifts.map((s) => s.userId).filter(Boolean)).size;
    // Capture one shared instant for both writes. Without this, RotaPublish's
    // auto-generated `publishedAt` (set here) and Shift's auto-generated
    // `@updatedAt` (set by Prisma at the updateMany's own execution time, a
    // few ms later) never line up — every shift would look "changed since
    // publish" the instant it was published, which is exactly backwards.
    const publishedAt = new Date();
    const [publish] = await prisma.$transaction([
      prisma.rotaPublish.upsert({
        where: { locationId_weekStart: { locationId, weekStart: start } },
        create: { locationId, weekStart: start, publishedAt, publishedById, notifiedCount },
        update: { publishedAt, publishedById, notifiedCount },
      }),
      prisma.shift.updateMany({
        where: { locationId, date: { gte: start, lt: end } },
        data: { status: 'PUBLISHED', updatedAt: publishedAt },
      }),
    ]);
    return res.status(200).json({ publishedAt: publish.publishedAt.toISOString(), notifiedCount: publish.notifiedCount });
  } catch (err) {
    console.error('[shifts.publish] failed', err);
    return res.status(500).json({ error: 'Unexpected error while publishing the week.' });
  }
});

/** GET /api/shifts/:locationId/publish-status?weekStart=YYYY-MM-DD */
shiftsRouter.get('/:locationId/publish-status', async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const publish = await prisma.rotaPublish.findUnique({ where: { locationId_weekStart: { locationId, weekStart: start } } });
    if (!publish) return res.status(200).json({ publishedAt: null, notifiedCount: 0, hasUnpublishedChanges: false });

    const changedCount = await prisma.shift.count({
      where: { locationId, date: { gte: start, lt: end }, updatedAt: { gt: publish.publishedAt } },
    });
    return res.status(200).json({
      publishedAt: publish.publishedAt.toISOString(),
      notifiedCount: publish.notifiedCount,
      hasUnpublishedChanges: changedCount > 0,
    });
  } catch (err) {
    console.error('[shifts.publishStatus] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading publish status.' });
  }
});
