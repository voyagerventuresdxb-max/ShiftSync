import { Router } from 'express';
import type { LeaveType, RotaLeave } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, optionalSession, ownedOrNotFound } from '../middleware/requireSession.js';
import { canSeeDraftShifts } from '../lib/shiftVisibility.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { LEAVE_LABELS, LEAVE_TYPES, deleteLeave, notifyPublishedLeaveChange, setLeave } from '../lib/actions/leaveActions.js';

/**
 * Leave chips on the rota builder grid (golden-path v0, 2026-09-25) — see
 * the RotaLeave model and lib/actions/leaveActions.ts for the rules.
 *
 * Audit: LEAVE_MARKED (create or type change) / LEAVE_REMOVED, entityType
 * "RotaLeave", with the leave in the note.
 */
export const rotaLeavesRouter = Router();

function leaveToDto(l: RotaLeave) {
  return {
    id: l.id,
    userId: l.userId,
    date: l.date.toISOString().slice(0, 10),
    type: l.type,
    status: l.status === 'PUBLISHED' ? ('published' as const) : ('draft' as const),
  };
}

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-31, 2026-13-01 — `new Date` would make those Invalid Date and 500). */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * GET /api/rota-leaves/:locationId?weekStart=YYYY-MM-DD — the 7 days from
 * weekStart. Leave type can be health data (Sick Leave), so this is stricter
 * than the shift read:
 *  - a manager of this venue sees everyone's leave, drafts included;
 *  - a staff member of this venue sees only their OWN leave, published only;
 *  - anyone else (anonymous kiosk, another venue) gets an empty list.
 */
rotaLeavesRouter.get('/:locationId', optionalSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!isIsoDate(weekStart)) return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    const isVenueManager = canSeeDraftShifts(req.user, locationId);
    const isVenueStaff = Boolean(req.user) && req.user!.locationId === locationId;
    if (!isVenueManager && !isVenueStaff) return res.status(200).json({ leaves: [] });
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    const leaves = await prisma.rotaLeave.findMany({
      where: {
        locationId,
        date: { gte: start, lt: end },
        ...(isVenueManager ? {} : { userId: req.user!.id, status: 'PUBLISHED' as const }),
      },
      orderBy: [{ date: 'asc' }],
    });
    return res.status(200).json({ leaves: leaves.map(leaveToDto) });
  } catch (err) {
    console.error('[rotaLeaves.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading leave.' });
  }
});

/**
 * PUT /api/rota-leaves — body: { userId, date, type }. Marks or changes that
 * person's leave for that day (one row per person per day). Location and
 * actor come from the session. 409 if a blocking type clashes with a shift.
 */
rotaLeavesRouter.put('/', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const userId = String(req.body?.userId ?? '').trim();
    const date = String(req.body?.date ?? '').trim();
    const type = String(req.body?.type ?? '').trim() as LeaveType;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    if (!isIsoDate(date)) return res.status(400).json({ error: 'date is required, as YYYY-MM-DD.' });
    if (!LEAVE_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of ${LEAVE_TYPES.join(', ')}.` });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!ownedOrNotFound(req, res, user, `Staff member "${userId}" not found.`)) return;

    const actorId = req.user!.id;
    const outcome = await withAuditedTransaction(
      prisma,
      (tx) => setLeave({ locationId, userId, date, type, createdById: actorId }, tx),
      (r) =>
        r.result === 'ok'
          ? { locationId, actorId, action: 'LEAVE_MARKED', entityType: 'RotaLeave', entityId: r.leave.id, note: `leave ${r.created ? 'marked' : 'changed'}: ${LEAVE_LABELS[type]} on ${date} for ${user.fullName}` }
          : null,
    );
    if (outcome.result === 'conflict') return res.status(409).json({ error: outcome.message });
    if (outcome.previous) {
      const { previous, leave } = outcome;
      void notifyPublishedLeaveChange(previous, leave).catch((err) => console.error('[rotaLeaves.set] notification failed', err));
    }
    return res.status(outcome.created ? 201 : 200).json({ leave: leaveToDto(outcome.leave) });
  } catch (err) {
    console.error('[rotaLeaves.set] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving leave.' });
  }
});

/** DELETE /api/rota-leaves/:id — manager-only, own venue only. */
rotaLeavesRouter.delete('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.rotaLeave.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Leave "${id}" not found.`)) return;
    await withAuditedTransaction(
      prisma,
      (tx) => deleteLeave(id, tx),
      () => ({
        locationId: existing.locationId,
        actorId: req.user!.id,
        action: 'LEAVE_REMOVED',
        entityType: 'RotaLeave',
        entityId: id,
        note: `leave removed: ${LEAVE_LABELS[existing.type]} on ${existing.date.toISOString().slice(0, 10)}`,
      }),
    );
    void notifyPublishedLeaveChange(existing, null).catch((err) => console.error('[rotaLeaves.delete] notification failed', err));
    return res.status(204).send();
  } catch (err) {
    console.error('[rotaLeaves.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while removing leave.' });
  }
});
