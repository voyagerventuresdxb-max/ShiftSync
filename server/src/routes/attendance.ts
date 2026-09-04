import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireSession, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { writeAuditLog } from '../lib/auditLog.js';

export const attendanceRouter = Router();

/**
 * Thrown inside the clock-in transaction when the re-checked "no open log"
 * fast-path guard finds one anyway — the common, non-racing case. See the
 * comment at its call site below: the real enforcement is now a DB-level
 * partial unique index, and a genuine race lands in the P2002 catch instead
 * of here.
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

    // RACE CLOSED. The real enforcement is a DB-level partial unique index
    // (`attendance_logs_one_open_per_user`, prisma/migrations/
    // 20260904152729_attendance_one_open_clock_in_per_user):
    // `CREATE UNIQUE INDEX ... ON attendance_logs (user_id) WHERE
    // clock_out_at IS NULL` — Postgres itself now refuses a second open log
    // for the same user, full stop, regardless of transaction interleaving
    // under READ COMMITTED. The `tx`-scoped `findFirst` below is kept as a
    // fast, friendly PRE-CHECK for the common sequential case only: it gives
    // a clean 409 without wasting a round trip attempting an insert that
    // would fail anyway. It is NOT what makes this safe. The actual
    // backstop for a genuine concurrent race is the `catch` below: if two
    // requests both pass the pre-check (both see "no open log") and both
    // attempt the `create`, Postgres's unique index lets exactly one commit
    // and rejects the other with a unique-violation, which Prisma surfaces
    // as `P2002` — caught and translated to the same 409 as the fast-path,
    // so callers never see a raw 500 for this.
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
        // Real backstop: the DB-level partial unique index rejected a
        // genuine concurrent double-create. Checking `meta.target` (not just
        // the P2002 code) matters — this transaction also writes an audit
        // log row, and a future unique constraint added to either model
        // would also throw P2002; without pinning down which one fired,
        // that unrelated violation would get silently swallowed and
        // misreported as "already clocked in" instead of surfacing as the
        // real bug it'd be. Verified empirically against this exact raw
        // index (Prisma doesn't expose the index's own name here, only the
        // column(s) the DB reported): `meta.target` for this specific
        // violation is `["user_id"]` — nothing else, since this partial
        // index is keyed on that one column. An exact-match check (not a
        // loose `.includes`) matters too: a future `@@unique([userId, x])`
        // would also report a `target` containing `"user_id"`, and a loose
        // check would wrongly treat that different constraint as this one.
        const target = err instanceof Prisma.PrismaClientKnownRequestError ? (err.meta?.target as unknown) : undefined;
        const isOpenClockInViolation =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          Array.isArray(target) &&
          target.length === 1 &&
          target[0] === 'user_id';
        if (isOpenClockInViolation) return null;
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
