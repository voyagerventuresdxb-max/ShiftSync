import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from '../parsing/normalize.js';
import { formatVenueTime } from '../lib/venueTime.js';
import { requireSession, requireManager, optionalSession, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { visibleShiftFilter } from '../lib/shiftVisibility.js';
import { writeAuditLog, withAuditedTransaction } from '../lib/auditLog.js';
import { notifySchedulePublished } from '../lib/scheduleNotifications.js';
import { createShift, updateShift, SHIFT_INCLUDE } from '../lib/actions/shiftActions.js';
import { publishRota } from '../lib/actions/rotaActions.js';

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

async function venueTimezone(locationId: string): Promise<string> {
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  return location?.timezone || DEFAULT_VENUE_TIMEZONE;
}

/**
 * GET /api/shifts/:locationId?weekStart=YYYY-MM-DD — the 7 days starting weekStart.
 * Deliberately NOT behind `requireSession` — the kiosk-access-fork decision
 * (Option 3, 2026-08-31 — see MEMORY.md): Home's anonymous glance board
 * needs this (via `AppStateContext.tsx`'s shared `refetchWeekShifts`, which
 * every consumer — signed-in or not — reads from). `/schedule` (the write
 * surface) requires a session; this read does not. Confirmed still correct
 * by the follow-up anonymous-read sweep.
 *
 * Drafts (2026-09-25, golden-path v0): PUBLISHED shifts only, unless the
 * caller is a manager of THIS venue (`optionalSession` + `visibleShiftFilter`)
 * — the builder needs its own drafts; staff and the anonymous kiosk never
 * see a shift before it's published.
 */
shiftsRouter.get('/:locationId', optionalSession, async (req, res) => {
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
      where: { locationId, date: { gte: start, lt: end }, ...visibleShiftFilter(req.user, locationId) },
      include: SHIFT_INCLUDE,
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
    return res.status(200).json({ shifts: shifts.map((s) => shiftToDto(s, timezone)) });
  } catch (err) {
    console.error('[shifts.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading shifts.' });
  }
});

/**
 * POST /api/shifts — body: { roleId, userId?, date, start, end, breakMinutes?, briefingNote?, sidework? }
 * `requireManager`-gated (2026-09-05 — see MEMORY.md; this was the real,
 * live gap a whole-branch review found: every mutation route here was
 * `requireSession`-only, so any authenticated STAFF session could create,
 * edit, delete, bulk-create, or publish shifts at their own venue via a
 * direct API call, including a coworker's — no UI needed, and the Shift
 * Editor's own client renders these controls with no role check of its own
 * either). `locationId`/the acting user still come from the caller's own
 * session, not a client-supplied value, the same way `swapRequests.ts`'s
 * POST already resolves `requestedById`. The actor (`createdById`) is always
 * the signed-in manager (2026-09-25): a body-supplied id used to be honored,
 * and the builder sent whoever was selected in "Viewing" — so the audit trail
 * could name a STAFF member as the author of a manager's change.
 */
shiftsRouter.post('/', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const roleId = String(req.body?.roleId ?? '').trim();
    const userId = req.body?.userId ? String(req.body.userId).trim() : null;
    const date = String(req.body?.date ?? '').trim();
    const start = String(req.body?.start ?? '').trim();
    const end = String(req.body?.end ?? '').trim();
    const breakMinutes = Number(req.body?.breakMinutes ?? 0);
    const briefingNote = req.body?.briefingNote ? String(req.body.briefingNote).trim() : null;
    const sidework = Array.isArray(req.body?.sidework) ? req.body.sidework.map(String) : [];
    // Always the signed-in manager — never a body-supplied id (an on-behalf
    // id let the audit trail name whoever was selected in "Viewing", even STAFF).
    const createdById = req.user!.id;

    if (!roleId) return res.status(400).json({ error: 'roleId is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date is required, as YYYY-MM-DD.' });
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'start/end are required, as HH:MM.' });
    }

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    // A removed role (roles.ts DELETE deactivates, never deletes, so existing
    // shifts keep theirs) can still be edited on an old shift, but no NEW
    // shift can be created on it.
    if (!role || role.locationId !== locationId || !role.isActive) return res.status(404).json({ error: `Role "${roleId}" not found or no longer active.` });
    if (userId) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.locationId !== locationId) return res.status(404).json({ error: `Staff member "${userId}" not found.` });
    }

    const timezone = await venueTimezone(locationId);
    const overnight = end <= start;
    const startTime = combineDateAndTime(date, start, timezone);
    const endTime = combineDateAndTime(date, end, timezone, overnight);

    const created = await withAuditedTransaction(
      prisma,
      (tx) =>
        createShift(
          { locationId, roleId, userId, createdById, date: new Date(`${date}T00:00:00.000Z`), startTime, endTime, breakMinutes, managerNotes: briefingNote, sidework, status: 'DRAFT' } as unknown as Parameters<typeof createShift>[0],
          tx,
        ),
      (shift) => ({ locationId, actorId: createdById, shiftId: shift.id, action: 'SHIFT_CREATED', entityType: 'Shift', entityId: shift.id }),
    );
    return res.status(201).json({ shift: shiftToDto(created, timezone) });
  } catch (err) {
    console.error('[shifts.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while creating the shift.' });
  }
});

/**
 * PATCH /api/shifts/:id — any subset of { roleId, userId, date, start, end, breakMinutes, briefingNote, sidework }
 * `requireManager`-gated (2026-09-05, same fix as POST /, above — see its
 * comment and MEMORY.md). The actor is always the session user, as POST /.
 */
shiftsRouter.patch('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.shift.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Shift "${id}" not found.`)) return;

    const timezone = await venueTimezone(existing.locationId);
    const data: Record<string, unknown> = {};
    // Same existence + same-location checks POST / already applies — without
    // these, PATCH could silently reassign a shift to a role/user from a
    // different location, or hit a raw FK-violation 500 instead of a clean 404.
    if (req.body?.roleId !== undefined) {
      const roleId = String(req.body.roleId);
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role || role.locationId !== existing.locationId) return res.status(404).json({ error: `Role "${roleId}" not found.` });
      data.roleId = roleId;
    }
    if (req.body?.userId !== undefined) {
      if (req.body.userId) {
        const userId = String(req.body.userId);
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.locationId !== existing.locationId) return res.status(404).json({ error: `Staff member "${userId}" not found.` });
        data.userId = userId;
      } else {
        data.userId = null;
      }
    }
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

    // Always the signed-in manager — never a body-supplied id (an on-behalf
    // id let the audit trail name whoever was selected in "Viewing", even STAFF).
    const actorId = req.user!.id;
    const updated = await withAuditedTransaction(
      prisma,
      (tx) => updateShift(id, data as Prisma.ShiftUpdateInput, tx),
      () => ({ locationId: existing.locationId, actorId, shiftId: id, action: 'SHIFT_UPDATED', entityType: 'Shift', entityId: id }),
    );
    return res.status(200).json({ shift: shiftToDto(updated, timezone) });
  } catch (err) {
    console.error('[shifts.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating the shift.' });
  }
});

/** DELETE /api/shifts/:id — `requireManager`-gated (2026-09-05, same fix as POST /, above); actor is always the session user, as PATCH. */
shiftsRouter.delete('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.shift.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Shift "${id}" not found.`)) return;
    // Always the signed-in manager — never a body-supplied id (an on-behalf
    // id let the audit trail name whoever was selected in "Viewing", even STAFF).
    const actorId = req.user!.id;
    await withAuditedTransaction(
      prisma,
      async (tx) => {
        // Audit-before-delete: writeAuditLog runs directly inside mutate (in
        // this original order), and buildEntry below returns null so the
        // helper doesn't also write a second row after the delete.
        await writeAuditLog(tx, { locationId: existing.locationId, actorId, shiftId: null, action: 'SHIFT_DELETED', entityType: 'Shift', entityId: id });
        await tx.shift.delete({ where: { id } });
      },
      () => null,
    );
    return res.status(204).send();
  } catch (err) {
    console.error('[shifts.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the shift.' });
  }
});

/**
 * POST /api/shifts/bulk — body: { shifts: [{ roleId, userId?, date, start, end, breakMinutes? }] }
 * `requireManager`-gated (2026-09-05, same fix as POST /, above). `locationId`
 * and the actor both come from the session — same rules as POST /.
 */
shiftsRouter.post('/bulk', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    // Always the signed-in manager — never a body-supplied id (an on-behalf
    // id let the audit trail name whoever was selected in "Viewing", even STAFF).
    const createdById = req.user!.id;
    type BulkShiftRow = { roleId?: unknown; userId?: unknown; date: string; start: string; end: string; breakMinutes?: number };
    const rows = (Array.isArray(req.body?.shifts) ? req.body.shifts : []) as BulkShiftRow[];
    if (rows.length === 0) return res.status(400).json({ error: 'shifts must be a non-empty array.' });

    // Validate every row's roleId/userId up front — same existence + same-
    // location checks POST / applies — so one bad id in the batch rejects
    // the whole request with a clean 404 instead of a raw FK-violation 500
    // thrown mid-transaction after some rows may already have committed.
    for (const r of rows) {
      if (!r?.roleId) return res.status(400).json({ error: 'Every row in shifts must include a roleId.' });
    }
    const roleIds: string[] = [...new Set(rows.map((r) => String(r.roleId)))];
    const userIds: string[] = [...new Set(rows.map((r) => (r.userId ? String(r.userId) : null)).filter((v): v is string => v !== null))];

    const roles = await prisma.role.findMany({ where: { id: { in: roleIds } } });
    const rolesById = new Map(roles.map((r) => [r.id, r]));
    for (const roleId of roleIds) {
      const role = rolesById.get(roleId);
      if (!role || role.locationId !== locationId) return res.status(404).json({ error: `Role "${roleId}" not found.` });
    }

    if (userIds.length > 0) {
      const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
      const usersById = new Map(users.map((u) => [u.id, u]));
      for (const userId of userIds) {
        const user = usersById.get(userId);
        if (!user || user.locationId !== locationId) return res.status(404).json({ error: `Staff member "${userId}" not found.` });
      }
    }

    const timezone = await venueTimezone(locationId);
    const created = await prisma.$transaction(
      rows.map((r) => {
        const overnight = r.end <= r.start;
        return prisma.shift.create({
          data: {
            locationId,
            roleId: String(r.roleId),
            userId: r.userId ? String(r.userId) : null,
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

/**
 * POST /api/shifts/:locationId/publish — body: { weekStart }
 * `requireManager`-gated (2026-09-05, same fix as POST /, above), scoped to
 * the caller's own location. `publishedById` is always the session user — a
 * body value is ignored (2026-09-25: the builder sent the "Viewing" employee,
 * so RotaPublish rows named a STAFF member as publisher).
 */
shiftsRouter.post('/:locationId/publish', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const weekStart = String(req.body?.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart is required, as YYYY-MM-DD.' });
    // Always the signed-in manager — never a body-supplied id (an on-behalf
    // id let the audit trail name whoever was selected in "Viewing", even STAFF).
    const publishedById = req.user!.id;

    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const result = await publishRota({ locationId, weekStart: start, publishedById });
    if (result.result === 'not_found') return res.status(404).json({ error: result.message });
    if (result.result === 'empty') return res.status(400).json({ error: result.message });

    // Real delivery on top of the flag-stamp above (never inside
    // publishRota's own transaction — a push failure must not roll back the
    // publish). Same call voice's /execute PUBLISH_ROTA case makes.
    void notifySchedulePublished(result.affectedUserIds, weekStart);

    return res.status(200).json({ publishedAt: result.publishedAt.toISOString(), notifiedCount: result.notifiedCount });
  } catch (err) {
    console.error('[shifts.publish] failed', err);
    return res.status(500).json({ error: 'Unexpected error while publishing the week.' });
  }
});

/**
 * GET /api/shifts/:locationId/publish-status?weekStart=YYYY-MM-DD
 * Deliberately NOT behind `requireSession` — same kiosk-access-fork
 * reasoning as the GET above (`AppStateContext.tsx`'s `refreshPublishInfo`
 * also runs for every consumer regardless of session). No sensitive content
 * either way: just a publish timestamp and a count. Confirmed still correct
 * by the follow-up anonymous-read sweep.
 */
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
