import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, ownedOrNotFound } from '../middleware/requireSession.js';
import { markAvailability } from '../lib/actions/availabilityActions.js';

export const availabilityRouter = Router();

/**
 * GET /api/availability/:userId?weekStart=YYYY-MM-DD
 *
 * Session-gated (2026-08-31 — see MEMORY.md; this route's own comment used
 * to justify staying anonymous by pointing at RotaBuilder having "no staff
 * session of its own" — stale reasoning found by the anonymous-read sweep:
 * RotaBuilder has lived inside the session-gated `/schedule` route since the
 * kiosk-access-fork phase, so that justification no longer holds). A read is
 * still open to any signed-in session, not just the mark's own owner or a
 * manager — managers read other people's marks to build the rota, and
 * narrowing this to self-or-manager-only would be a real behavior change
 * beyond the auth-layer fix this sweep is scoped to; only anonymous access
 * is closed here. The target user must belong to the caller's own venue.
 */
availabilityRouter.get('/:userId', requireSession, async (req, res) => {
  try {
    const { userId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    }
    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!ownedOrNotFound(req, res, targetUser, `Staff member "${userId}" not found.`)) return;
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const marks = await prisma.availabilityMark.findMany({ where: { userId, date: { gte: start, lt: end } } });
    return res.status(200).json({
      marks: marks.map((m) => ({ id: m.id, date: m.date.toISOString().slice(0, 10), type: m.type, note: m.note })),
    });
  } catch (err) {
    console.error('[availability.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading availability.' });
  }
});

/**
 * POST /api/availability — body: { date, type, note? } — upserts one mark per
 * (userId, date). Session-gated: the user is taken from the resolved session,
 * and any `userId` in the request body is ignored outright. A staff member can
 * only ever mark their OWN availability.
 */
availabilityRouter.post('/', requireSession, async (req, res) => {
  try {
    const userId = req.user!.id;
    const dateStr = String(req.body?.date ?? '').trim();
    const type = String(req.body?.type ?? '');
    const note = req.body?.note ? String(req.body.note).trim() : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'date is required, as YYYY-MM-DD.' });
    if (type !== 'UNAVAILABLE' && type !== 'PREFERRED_OFF') {
      return res.status(400).json({ error: 'type must be "UNAVAILABLE" or "PREFERRED_OFF".' });
    }

    const outcome = await markAvailability({ userId, date: dateStr, type, note });
    const { mark } = outcome;
    return res.status(201).json({ id: mark.id, date: mark.date, type: mark.type, note: mark.note });
  } catch (err) {
    console.error('[availability.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the availability mark.' });
  }
});

/** DELETE /api/availability/:id — session-gated, and only the mark's own owner may remove it. */
availabilityRouter.delete('/:id', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.availabilityMark.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Availability mark "${id}" not found.` });
    if (existing.userId !== req.user!.id) {
      return res.status(403).json({ error: 'You can only remove your own availability marks.' });
    }
    await prisma.availabilityMark.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    console.error('[availability.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while removing the availability mark.' });
  }
});
