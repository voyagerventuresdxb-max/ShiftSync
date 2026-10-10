import { Router, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { DEFAULT_VENUE_TIMEZONE } from '../parsing/normalize.js';
import { formatVenueTime } from '../lib/venueTime.js';
import { isMondayIso, WEEK_START_NOT_MONDAY_ERROR } from '../lib/venueWeek.js';
import { requireSession, requireManager, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { notifySchedulePublished } from '../lib/scheduleNotifications.js';
import { updateShift, SHIFT_INCLUDE } from '../lib/actions/shiftActions.js';
import { findActiveVenueRole, findVenueUser } from '../lib/shiftRules.js';
import { publishRota } from '../lib/actions/rotaActions.js';
import { applyWeekPatch, shiftInstantsOf, toldShiftOf, toldSnapshotOf, type WeekSnapshot } from '../lib/actions/weekActions.js';
import { mondayOf, type WeekPatchOp, type WeekPatchResult } from '../../../shared/rotaWeek.js';
import { onBehalfUserId } from '../lib/onBehalf.js';
import { requireSessionOrKioskToken } from '../middleware/kioskAccess.js';

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

/** A kiosk screen's view of a published shift: who, which role, when — no user ids, notes or anything else. */
function shiftToKioskDto(
  s: { id: string; date: Date; startTime: Date; endTime: Date; assignee: { fullName: string } | null; role: { name: string } },
  timezone: string,
) {
  return {
    id: s.id,
    employeeName: s.assignee?.fullName ?? null,
    roleName: s.role.name,
    date: s.date.toISOString().slice(0, 10),
    start: formatVenueTime(s.startTime, timezone),
    end: formatVenueTime(s.endTime, timezone),
    status: 'published' as const,
  };
}

async function venueTimezone(locationId: string): Promise<string> {
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { timezone: true } });
  return location?.timezone || DEFAULT_VENUE_TIMEZONE;
}

/**
 * Rota builder v2: every mutation here is a one-op patch on the shift's week
 * (lib/actions/weekActions.ts), so the legacy Shift Editor and the new week
 * grid share one rule set and one version counter. These routes present no
 * `expectedVersion` (the old client has none), which weekActions logs once.
 * A refusal maps to the status the old client already handles: an unknown
 * id → 404 (as the pre-v2 lookups did), a collision with another shift, a
 * leave or a pending request → 409, anything else about the request → 422.
 */
function sendPatchFailure(res: Response, result: Exclude<WeekPatchResult, { result: 'ok' }>): void {
  if (result.result === 'version_conflict') {
    res.status(409).json({ error: 'The week changed while you were editing — reload and try again.', errorCode: 'version_conflict' });
    return;
  }
  const { refusal, message } = result;
  const notFound = refusal === 'unknown_shift' || refusal === 'unknown_person' || refusal === 'unknown_role' || refusal === 'unknown_shift_type';
  const conflict = refusal === 'already_has_shift' || refusal === 'overlap' || refusal === 'person_on_leave' || refusal === 'pending_request' || refusal === 'leave_over_shift';
  res.status(notFound ? 404 : conflict ? 409 : 422).json({ error: message, refusal });
}

/**
 * GET /api/shifts/:locationId?weekStart=YYYY-MM-DD — the 7 days starting weekStart.
 * A session of this venue gets every shift, drafts included. A kiosk screen
 * (the venue's current `X-Kiosk-Token`, see middleware/kioskAccess.ts) gets
 * only PUBLISHED shifts, as `shiftToKioskDto`. A venue id alone gets 401.
 * CANCELLED rows (a published shift removed but not yet re-published, see
 * weekActions) are never listed to a manager: to this client they are gone.
 *
 * Rota builder v2: a STAFF session gets the same published-only view as the
 * kiosk (in the full DTO shape): every shift as staff were last told it
 * (weekActions.toldShiftOf), so a draft or an unpublished edit never reaches
 * staff through this older route either.
 */
shiftsRouter.get('/:locationId', requireSessionOrKioskToken, async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    }
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const kiosk = req.kioskLocationId !== undefined;
    const toldView = kiosk || req.user?.systemRole === 'STAFF';
    const timezone = await venueTimezone(locationId);
    const shifts = await prisma.shift.findMany({
      where: { locationId, date: { gte: start, lt: end }, status: toldView ? { in: ['PUBLISHED', 'COMPLETED', 'CANCELLED'] } : { not: 'CANCELLED' } },
      include: SHIFT_INCLUDE,
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
    if (!toldView) return res.status(200).json({ shifts: shifts.map((s) => shiftToDto(s, timezone)) });

    const snapshots = new Map<string, WeekSnapshot | null>();
    const told: { row: (typeof shifts)[number]; view: NonNullable<ReturnType<typeof toldShiftOf>> }[] = [];
    for (const row of shifts) {
      const week = mondayOf(row.date.toISOString().slice(0, 10));
      if (!snapshots.has(week)) snapshots.set(week, await toldSnapshotOf(prisma, locationId, week, timezone));
      const view = toldShiftOf(row, snapshots.get(week) ?? null, timezone);
      if (view) told.push({ row, view });
    }
    // A shift reassigned since publish still shows under the person who was told it.
    const otherIds = [...new Set(told.map((t) => t.view.userId).filter((id): id is string => id !== null && !told.some((t) => t.row.assignee?.id === id)))];
    const names = new Map((await prisma.user.findMany({ where: { id: { in: otherIds }, locationId }, select: { id: true, fullName: true } })).map((u) => [u.id, u]));
    for (const t of told) if (t.row.assignee) names.set(t.row.assignee.id, t.row.assignee);
    const dtos = told
      .map(({ row, view }) => {
        const asTold = {
          ...row,
          ...shiftInstantsOf(view.date, view.ranges, timezone),
          userId: view.userId,
          assignee: view.userId ? (names.get(view.userId) ?? null) : null,
          date: new Date(`${view.date}T00:00:00.000Z`),
          status: 'PUBLISHED',
        };
        return kiosk ? shiftToKioskDto(asTold, timezone) : shiftToDto(asTold, timezone);
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    return res.status(200).json({ shifts: dtos });
  } catch (err) {
    console.error('[shifts.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading shifts.' });
  }
});

/**
 * POST /api/shifts — body: { roleId, userId?, date, start, end, breakMinutes?, briefingNote?, sidework?, createdById? }
 * `requireManager`-gated (2026-09-05 — see MEMORY.md; this was the real,
 * live gap a whole-branch review found: every mutation route here was
 * `requireSession`-only, so any authenticated STAFF session could create,
 * edit, delete, bulk-create, or publish shifts at their own venue via a
 * direct API call, including a coworker's — no UI needed, and the Shift
 * Editor's own client renders these controls with no role check of its own
 * either). `locationId`/the acting user still come from the caller's own
 * session, not a client-supplied value, the same way `swapRequests.ts`'s
 * POST already resolves `requestedById`. `createdById` in the body is
 * honored for whichever MANAGER/OWNER is filing on behalf of the staff
 * member selected in the Shift Editor's "Viewing" dropdown; the `STAFF ?
 * self : ...` branch below is now unreachable (no STAFF session can pass
 * `requireManager`) and kept only as defense in depth, matching this
 * codebase's existing style at every other on-behalf-of site.
 *
 * The shift itself is written by a one-op week patch (see sendPatchFailure);
 * `breakMinutes`/`briefingNote`/`sidework` are legacy, manager-only fields
 * outside the week document, applied to the new row right after.
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
    const createdById = await onBehalfUserId(req, res, 'createdById');
    if (!createdById) return;

    if (!roleId) return res.status(400).json({ error: 'roleId is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date is required, as YYYY-MM-DD.' });
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'start/end are required, as HH:MM.' });
    }

    // A removed role (roles.ts DELETE deactivates, never deletes, so existing
    // shifts keep theirs) can still be edited on an old shift, but no NEW
    // shift can be created on it. Same check as voice's CREATE_SHIFT (lib/shiftRules.ts).
    if (!(await findActiveVenueRole(roleId, locationId))) return res.status(404).json({ error: `Role "${roleId}" not found or no longer active.` });
    if (userId && !(await findVenueUser(userId, locationId))) return res.status(404).json({ error: `Staff member "${userId}" not found.` });

    const timezone = await venueTimezone(locationId);
    const result = await applyWeekPatch({
      locationId,
      weekStart: mondayOf(date),
      actorId: createdById,
      source: 'grid',
      patch: { ops: [{ op: 'create', userId, roleId, date, ranges: [{ start, end }] }] },
    });
    if (result.result !== 'ok') return sendPatchFailure(res, result);
    const shiftId = result.results[0]!.shiftId!;
    const created = await updateShift(shiftId, { breakMinutes, managerNotes: briefingNote, sidework });
    return res.status(201).json({ shift: shiftToDto(created, timezone) });
  } catch (err) {
    console.error('[shifts.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while creating the shift.' });
  }
});

/**
 * PATCH /api/shifts/:id — any subset of { roleId, userId, date, start, end, breakMinutes, briefingNote, sidework, actorId }
 * `requireManager`-gated (2026-09-05, same fix as POST /, above — see its
 * comment and MEMORY.md). `actorId` in the body is honored for whichever
 * MANAGER/OWNER is acting (same "Viewing" on-behalf-of pattern as POST /).
 *
 * Who/when fields go through a one-op week patch on the shift's current
 * week (a move to another week is refused `outside_week`: the old client
 * never offered one); the legacy manager-only fields are written directly.
 */
shiftsRouter.patch('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const found = await prisma.shift.findUnique({ where: { id } });
    // A soft-cancelled shift is gone as far as this client is concerned: the same 404 as a missing one.
    const existing = found && found.status !== 'CANCELLED' ? found : null;
    if (!ownedOrNotFound(req, res, existing, `Shift "${id}" not found.`)) return;

    const timezone = await venueTimezone(existing.locationId);
    const op: Extract<WeekPatchOp, { op: 'update' }> = { op: 'update', shiftId: id };
    let touchesWeek = false;
    // Same existence + same-location checks POST / already applies — without
    // these, PATCH could silently reassign a shift to a role/user from a
    // different location, or hit a raw FK-violation 500 instead of a clean 404.
    if (req.body?.roleId !== undefined) {
      const roleId = String(req.body.roleId);
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role || role.locationId !== existing.locationId) return res.status(404).json({ error: `Role "${roleId}" not found.` });
      if (roleId !== existing.roleId) {
        op.roleId = roleId;
        touchesWeek = true;
      }
    }
    if (req.body?.userId !== undefined) {
      if (req.body.userId) {
        const userId = String(req.body.userId);
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.locationId !== existing.locationId) return res.status(404).json({ error: `Staff member "${userId}" not found.` });
        op.userId = userId;
      } else {
        op.userId = null;
      }
      if (op.userId === existing.userId) delete op.userId;
      else touchesWeek = true;
    }
    const legacy: Prisma.ShiftUpdateInput = {};
    if (req.body?.breakMinutes !== undefined) legacy.breakMinutes = Number(req.body.breakMinutes);
    if (req.body?.briefingNote !== undefined) legacy.managerNotes = req.body.briefingNote ? String(req.body.briefingNote) : null;
    if (req.body?.sidework !== undefined) legacy.sidework = Array.isArray(req.body.sidework) ? req.body.sidework.map(String) : [];

    // The old Shift Editor sends date/start/end back unchanged on every save: only a real change goes into the
    // patch, so saving a split shift's break minutes doesn't collapse its two ranges into one.
    if (req.body?.date !== undefined && String(req.body.date) !== existing.date.toISOString().slice(0, 10)) {
      op.date = String(req.body.date);
      touchesWeek = true;
    }
    if (req.body?.start !== undefined || req.body?.end !== undefined) {
      const currentStart = formatVenueTime(existing.startTime, timezone);
      const currentEnd = formatVenueTime(existing.endTime, timezone);
      const nextStart = req.body?.start !== undefined ? String(req.body.start) : currentStart;
      const nextEnd = req.body?.end !== undefined ? String(req.body.end) : currentEnd;
      if (nextStart !== currentStart || nextEnd !== currentEnd) {
        op.ranges = [{ start: nextStart, end: nextEnd }];
        touchesWeek = true;
      }
    }

    const actorId = await onBehalfUserId(req, res, 'actorId');
    if (!actorId) return;
    if (touchesWeek) {
      const result = await applyWeekPatch({
        locationId: existing.locationId,
        weekStart: mondayOf(existing.date.toISOString().slice(0, 10)),
        actorId,
        source: 'grid',
        patch: { ops: [op] },
      });
      if (result.result !== 'ok') return sendPatchFailure(res, result);
    }
    const updated = await withAuditedTransaction(
      prisma,
      (tx) => updateShift(id, legacy, tx),
      // The week patch audits the who/when change itself; a legacy-only edit still gets its own row.
      () => (touchesWeek ? null : { locationId: existing.locationId, actorId, shiftId: id, action: 'SHIFT_UPDATED', entityType: 'Shift', entityId: id }),
    );
    return res.status(200).json({ shift: shiftToDto(updated, timezone) });
  } catch (err) {
    console.error('[shifts.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating the shift.' });
  }
});

/**
 * DELETE /api/shifts/:id — body (optional): { actorId }. `requireManager`-gated (2026-09-05, same fix as POST /, above); same on-behalf-of rule as PATCH.
 * A draft is removed outright; a published shift is soft-cancelled (hidden from every list) so the next publish can tell the person — see weekActions.
 */
shiftsRouter.delete('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const found = await prisma.shift.findUnique({ where: { id } });
    const existing = found && found.status !== 'CANCELLED' ? found : null;
    if (!ownedOrNotFound(req, res, existing, `Shift "${id}" not found.`)) return;
    const actorId = await onBehalfUserId(req, res, 'actorId');
    if (!actorId) return;
    const result = await applyWeekPatch({
      locationId: existing.locationId,
      weekStart: mondayOf(existing.date.toISOString().slice(0, 10)),
      actorId,
      source: 'grid',
      patch: { ops: [{ op: 'delete', shiftId: id }] },
    });
    if (result.result !== 'ok') return sendPatchFailure(res, result);
    return res.status(204).send();
  } catch (err) {
    console.error('[shifts.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the shift.' });
  }
});

/**
 * POST /api/shifts/bulk — body: { createdById?, shifts: [{ roleId, userId?, date, start, end, breakMinutes? }] }
 * `requireManager`-gated (2026-09-05, same fix as POST /, above). `locationId`
 * comes from the session, and `createdById` in the body is honored for
 * whichever MANAGER/OWNER is acting — same rules as POST /.
 *
 * One week patch per distinct week in the batch (a week is the unit of
 * versioning), each all-or-nothing; a batch spanning weeks is therefore
 * atomic per week, not across them.
 */
shiftsRouter.post('/bulk', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const createdById = await onBehalfUserId(req, res, 'createdById');
    if (!createdById) return;
    type BulkShiftRow = { roleId?: unknown; userId?: unknown; date: string; start: string; end: string; breakMinutes?: number };
    const rows = (Array.isArray(req.body?.shifts) ? req.body.shifts : []) as BulkShiftRow[];
    if (rows.length === 0) return res.status(400).json({ error: 'shifts must be a non-empty array.' });

    // Validate every row's roleId/userId up front — same existence + same-
    // location checks POST / applies — so one bad id in the batch rejects
    // the whole request with a clean 404 instead of a raw FK-violation 500
    // thrown mid-transaction after some rows may already have committed.
    for (const r of rows) {
      if (!r?.roleId) return res.status(400).json({ error: 'Every row in shifts must include a roleId.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date ?? ''))) return res.status(400).json({ error: 'Every row in shifts must include a date, as YYYY-MM-DD.' });
      if (!/^\d{2}:\d{2}$/.test(String(r.start ?? '')) || !/^\d{2}:\d{2}$/.test(String(r.end ?? ''))) {
        return res.status(400).json({ error: 'Every row in shifts must include start/end, as HH:MM.' });
      }
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
    const byWeek = new Map<string, BulkShiftRow[]>();
    for (const r of rows) {
      const weekStart = mondayOf(r.date);
      byWeek.set(weekStart, [...(byWeek.get(weekStart) ?? []), r]);
    }
    const createdIds: string[] = [];
    for (const [weekStart, weekRows] of byWeek) {
      const result = await applyWeekPatch({
        locationId,
        weekStart,
        actorId: createdById,
        source: 'bulk',
        patch: {
          ops: weekRows.map((r): WeekPatchOp => ({ op: 'create', userId: r.userId ? String(r.userId) : null, roleId: String(r.roleId), date: r.date, ranges: [{ start: r.start, end: r.end }] })),
        },
      });
      if (result.result !== 'ok') return sendPatchFailure(res, result);
      for (const [i, r] of weekRows.entries()) {
        const shiftId = result.results[i]!.shiftId!;
        createdIds.push(shiftId);
        if (r.breakMinutes) await prisma.shift.update({ where: { id: shiftId }, data: { breakMinutes: r.breakMinutes } });
      }
    }
    const created = await prisma.shift.findMany({ where: { id: { in: createdIds } }, include: SHIFT_INCLUDE, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] });
    return res.status(201).json({ shifts: created.map((s) => shiftToDto(s, timezone)), createdCount: created.length });
  } catch (err) {
    console.error('[shifts.bulk] failed', err);
    return res.status(500).json({ error: 'Unexpected error while bulk-creating shifts.' });
  }
});

/**
 * POST /api/shifts/:locationId/publish — body: { weekStart, publishedById? }
 * `requireManager`-gated (2026-09-05, same fix as POST /, above), scoped to
 * the caller's own location; `publishedById` in the body is honored for
 * whichever MANAGER/OWNER is acting — same rules as POST /.
 */
shiftsRouter.post('/:locationId/publish', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const weekStart = String(req.body?.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart is required, as YYYY-MM-DD.' });
    // RotaPublish is keyed on the Monday; a non-Monday would publish a
    // misaligned 7 days and leave an orphan publish row no status read finds.
    if (!isMondayIso(weekStart)) return res.status(400).json({ error: WEEK_START_NOT_MONDAY_ERROR });
    const publishedById = await onBehalfUserId(req, res, 'publishedById');
    if (!publishedById) return;

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
 * A session of this venue, or a kiosk screen with the venue's current kiosk
 * token (same gate as the GET above): a publish timestamp and a count.
 * Reads the v2 week row when the week has one (its version vs published
 * version is the authoritative "edited since publish"), else the legacy
 * RotaPublish comparison.
 */
shiftsRouter.get('/:locationId/publish-status', requireSessionOrKioskToken, async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const publish = await prisma.rotaPublish.findUnique({ where: { locationId_weekStart: { locationId, weekStart: start } } });
    const week = await prisma.rotaWeek.findUnique({ where: { locationId_weekStart: { locationId, weekStart: start } } });
    if (week?.publishedAt) {
      const pendingRows = await prisma.shift.count({
        where: { locationId, date: { gte: start, lt: end }, OR: [{ status: 'DRAFT' }, { status: 'CANCELLED' }, { editedSincePublish: true }] },
      });
      return res.status(200).json({
        publishedAt: week.publishedAt.toISOString(),
        notifiedCount: publish?.notifiedCount ?? 0,
        hasUnpublishedChanges: pendingRows > 0 || week.version !== week.publishedVersion,
      });
    }
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
