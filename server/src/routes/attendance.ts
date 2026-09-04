import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { writeAuditLog } from '../lib/auditLog.js';

export const attendanceRouter = Router();

/**
 * Thrown inside the clock-in transaction when the re-checked "no open log"
 * guard finds one anyway — see the comment at its call site below for why
 * this only narrows, rather than closes, the underlying race.
 */
class AlreadyClockedInError extends Error {}

/**
 * POST /api/attendance/clock-in — body: { userId?, shiftId? }
 * Session-gated. `userId` in the body is only honored for a MANAGER/OWNER
 * session naming a different staff member (same on-behalf-of rule as
 * shifts.ts's POST /) — a STAFF session can only ever clock itself in. The
 * effective target user must belong to the caller's own venue.
 */
attendanceRouter.post('/clock-in', requireSession, async (req, res) => {
  try {
    const effectiveUserId =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.userId ? String(req.body.userId).trim() : '') || req.user!.id;
    const shiftId = req.body?.shiftId ? String(req.body.shiftId).trim() : null;

    const user = await prisma.user.findUnique({ where: { id: effectiveUserId } });
    if (!ownedOrNotFound(req, res, user, `Staff member "${effectiveUserId}" not found.`)) return;

    if (shiftId) {
      const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
      if (!ownedOrNotFound(req, res, shift, `Shift "${shiftId}" not found.`)) return;
    }

    // The "already clocked in" guard is re-checked with `tx` immediately
    // before the create, inside the same transaction, instead of via a plain
    // `prisma` read beforehand — this narrows the TOCTOU window from the
    // whole request down to two round trips inside one transaction. It does
    // NOT fully close it: this is a CREATE (a brand-new row), not an update
    // of an existing row, so there is no prior row to put a conditional
    // `WHERE` on the way `joinActions.ts`/`swapActions.ts`/`staffDirectory.ts`
    // do. Under Postgres's default READ COMMITTED isolation, two concurrent
    // transactions can still both run this `findFirst` and both see "no open
    // log" before either commits its `create` — so two opens for the same
    // user remain possible in a genuine simultaneous-request race. Closing
    // that fully would need a DB-level partial unique index (`CREATE UNIQUE
    // INDEX ... ON attendance_logs (user_id) WHERE clock_out_at IS NULL`),
    // which was deliberately not added here — see MEMORY.md for why.
    const log = await prisma
      .$transaction(async (tx) => {
        const open = await tx.attendanceLog.findFirst({ where: { userId: effectiveUserId, clockOutAt: null }, orderBy: { createdAt: 'desc' } });
        if (open) {
          throw new AlreadyClockedInError();
        }
        const created = await tx.attendanceLog.create({ data: { userId: effectiveUserId, shiftId, clockInAt: new Date(), source: 'manual' } });
        await writeAuditLog(tx, {
          locationId: req.user!.locationId,
          actorId: req.user!.id,
          action: 'CLOCKED_IN',
          entityType: 'AttendanceLog',
          entityId: created.id,
          note: effectiveUserId === req.user!.id ? undefined : `Clocked in ${user.fullName} on their behalf`,
        });
        return created;
      })
      .catch((err) => {
        if (err instanceof AlreadyClockedInError) return null;
        throw err;
      });
    if (!log) return res.status(409).json({ error: 'Already clocked in — clock out first.' });
    return res.status(201).json({ id: log.id, clockInAt: log.clockInAt!.toISOString(), clockOutAt: null });
  } catch (err) {
    console.error('[attendance.clockIn] failed', err);
    return res.status(500).json({ error: 'Unexpected error while clocking in.' });
  }
});

/**
 * POST /api/attendance/clock-out — body: { userId? } — closes the effective
 * target's own open log. Session-gated; same on-behalf-of rule as clock-in.
 */
attendanceRouter.post('/clock-out', requireSession, async (req, res) => {
  try {
    const effectiveUserId =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.userId ? String(req.body.userId).trim() : '') || req.user!.id;

    const user = await prisma.user.findUnique({ where: { id: effectiveUserId } });
    if (!ownedOrNotFound(req, res, user, `Staff member "${effectiveUserId}" not found.`)) return;

    const open = await prisma.attendanceLog.findFirst({ where: { userId: effectiveUserId, clockOutAt: null }, orderBy: { createdAt: 'desc' } });
    if (!open) return res.status(409).json({ error: 'Not currently clocked in.' });

    const closed = await prisma.$transaction(async (tx) => {
      const updated = await tx.attendanceLog.update({ where: { id: open.id }, data: { clockOutAt: new Date() } });
      await writeAuditLog(tx, {
        locationId: req.user!.locationId,
        actorId: req.user!.id,
        action: 'CLOCKED_OUT',
        entityType: 'AttendanceLog',
        entityId: updated.id,
        note: effectiveUserId === req.user!.id ? undefined : `Clocked out ${user.fullName} on their behalf`,
      });
      return updated;
    });
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
 * Session-gated (2026-08-31 — see MEMORY.md): real per-person worked-hours
 * totals and live clocked-in status are payroll-adjacent data, not
 * structural metadata — the anonymous-read sweep found this had neither a
 * session check nor a comment justifying one, unlike this codebase's other
 * deliberately-anonymous GETs.
 */
attendanceRouter.get('/:locationId/weekly-hours', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });

    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const users = await prisma.user.findMany({ where: { locationId, isActive: true }, select: { id: true, fullName: true } });
    const userIds = users.map((u) => u.id);
    const logs = await prisma.attendanceLog.findMany({
      where: { userId: { in: userIds }, clockInAt: { gte: start, lt: end } },
    });

    // "Currently clocked in" is independent of the viewed week — an open log
    // started in a prior week (or spanning midnight into this one) still
    // means the employee is clocked in right now.
    const openLogs = await prisma.attendanceLog.findMany({
      where: { userId: { in: userIds }, clockOutAt: null },
      select: { userId: true },
    });
    const clockedInUserIds = new Set(openLogs.map((l) => l.userId));

    const now = Date.now();
    const hoursByUser = new Map<string, number>();
    for (const log of logs) {
      if (!log.clockInAt) continue;
      const endMs = log.clockOutAt ? log.clockOutAt.getTime() : now;
      const hours = Math.max(0, (endMs - log.clockInAt.getTime()) / 3_600_000);
      hoursByUser.set(log.userId, (hoursByUser.get(log.userId) ?? 0) + hours);
    }

    return res.status(200).json({
      staff: users.map((u) => ({
        id: u.id,
        name: u.fullName,
        hours: Math.round((hoursByUser.get(u.id) ?? 0) * 100) / 100,
        clockedIn: clockedInUserIds.has(u.id),
      })),
    });
  } catch (err) {
    console.error('[attendance.weeklyHours] failed', err);
    return res.status(500).json({ error: 'Unexpected error while computing weekly hours.' });
  }
});
