import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

export const attendanceRouter = Router();

/** POST /api/attendance/clock-in — body: { userId, shiftId? } */
attendanceRouter.post('/clock-in', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '').trim();
    const shiftId = req.body?.shiftId ? String(req.body.shiftId).trim() : null;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: `Staff member "${userId}" not found.` });

    if (shiftId) {
      const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
      if (!shift) return res.status(404).json({ error: `Shift "${shiftId}" not found.` });
    }

    const open = await prisma.attendanceLog.findFirst({ where: { userId, clockOutAt: null }, orderBy: { createdAt: 'desc' } });
    if (open) return res.status(409).json({ error: 'Already clocked in — clock out first.' });

    const log = await prisma.attendanceLog.create({ data: { userId, shiftId, clockInAt: new Date(), source: 'manual' } });
    return res.status(201).json({ id: log.id, clockInAt: log.clockInAt!.toISOString(), clockOutAt: null });
  } catch (err) {
    console.error('[attendance.clockIn] failed', err);
    return res.status(500).json({ error: 'Unexpected error while clocking in.' });
  }
});

/** POST /api/attendance/clock-out — body: { userId } — closes the caller's own open log. */
attendanceRouter.post('/clock-out', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '').trim();
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const open = await prisma.attendanceLog.findFirst({ where: { userId, clockOutAt: null }, orderBy: { createdAt: 'desc' } });
    if (!open) return res.status(409).json({ error: 'Not currently clocked in.' });

    const closed = await prisma.attendanceLog.update({ where: { id: open.id }, data: { clockOutAt: new Date() } });
    return res.status(200).json({ id: closed.id, clockInAt: closed.clockInAt!.toISOString(), clockOutAt: closed.clockOutAt!.toISOString() });
  } catch (err) {
    console.error('[attendance.clockOut] failed', err);
    return res.status(500).json({ error: 'Unexpected error while clocking out.' });
  }
});

/**
 * GET /api/attendance/:locationId/weekly-hours?weekStart=YYYY-MM-DD
 * Real worked hours per staff member for the week, computed from actual
 * clockIn/clockOut pairs — NOT from the scheduled rota. An open (not yet
 * clocked out) log counts up to "now" so the running total is live.
 */
attendanceRouter.get('/:locationId/weekly-hours', async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });

    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const users = await prisma.user.findMany({ where: { locationId, isActive: true }, select: { id: true, fullName: true } });
    const logs = await prisma.attendanceLog.findMany({
      where: { userId: { in: users.map((u) => u.id) }, clockInAt: { gte: start, lt: end } },
    });

    const now = Date.now();
    const hoursByUser = new Map<string, number>();
    for (const log of logs) {
      if (!log.clockInAt) continue;
      const endMs = log.clockOutAt ? log.clockOutAt.getTime() : now;
      const hours = Math.max(0, (endMs - log.clockInAt.getTime()) / 3_600_000);
      hoursByUser.set(log.userId, (hoursByUser.get(log.userId) ?? 0) + hours);
    }

    return res.status(200).json({
      staff: users.map((u) => ({ id: u.id, name: u.fullName, hours: Math.round((hoursByUser.get(u.id) ?? 0) * 100) / 100 })),
    });
  } catch (err) {
    console.error('[attendance.weeklyHours] failed', err);
    return res.status(500).json({ error: 'Unexpected error while computing weekly hours.' });
  }
});
