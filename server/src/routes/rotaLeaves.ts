import { Router } from 'express';
import type { LeaveType, RotaLeave } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, optionalSession, ownedOrNotFound } from '../middleware/requireSession.js';
import { canSeeDraftShifts } from '../lib/shiftVisibility.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { LEAVE_LABELS, LEAVE_TYPES, deleteLeave, setLeave } from '../lib/actions/leaveActions.js';

/**
 * Leave chips on the rota builder grid (golden-path v0, 2026-09-25) — see
 * the RotaLeave model and lib/actions/leaveActions.ts for the rules.
 *
 * Audit: there is no leave-specific AuditAction yet (adding one is a schema
 * change of its own), so writes log as MANUAL_OVERRIDE with
 * entityType "RotaLeave" and the leave in the note.
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

/**
 * GET /api/rota-leaves/:locationId?weekStart=YYYY-MM-DD — the 7 days from
 * weekStart. Same visibility as GET /api/shifts/:locationId: drafts only for
 * a manager of this venue; staff and the anonymous kiosk get PUBLISHED only.
 */
rotaLeavesRouter.get('/:locationId', optionalSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    const leaves = await prisma.rotaLeave.findMany({
      where: { locationId, date: { gte: start, lt: end }, ...(canSeeDraftShifts(req.user, locationId) ? {} : { status: 'PUBLISHED' as const }) },
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date is required, as YYYY-MM-DD.' });
    if (!LEAVE_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of ${LEAVE_TYPES.join(', ')}.` });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!ownedOrNotFound(req, res, user, `Staff member "${userId}" not found.`)) return;

    const actorId = req.user!.id;
    const outcome = await withAuditedTransaction(
      prisma,
      (tx) => setLeave({ locationId, userId, date, type, createdById: actorId }, tx),
      (r) =>
        r.result === 'ok'
          ? { locationId, actorId, action: 'MANUAL_OVERRIDE', entityType: 'RotaLeave', entityId: r.leave.id, note: `leave ${r.created ? 'marked' : 'changed'}: ${LEAVE_LABELS[type]} on ${date} for ${user.fullName}` }
          : null,
    );
    if (outcome.result === 'conflict') return res.status(409).json({ error: outcome.message });
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
        action: 'MANUAL_OVERRIDE',
        entityType: 'RotaLeave',
        entityId: id,
        note: `leave removed: ${LEAVE_LABELS[existing.type]} on ${existing.date.toISOString().slice(0, 10)}`,
      }),
    );
    return res.status(204).send();
  } catch (err) {
    console.error('[rotaLeaves.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while removing leave.' });
  }
});
