import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';

export const availabilityRouter = Router();

/**
 * GET /api/availability/:userId?weekStart=YYYY-MM-DD
 *
 * Deliberately NOT behind `requireSession`: availability marks are read by
 * RotaBuilder (a manager screen with no staff session of its own) to render
 * its informational scheduling badges, which means reading OTHER people's
 * marks. Only the two mutating handlers below are session-gated — a staff
 * member can only ever change their own availability.
 */
availabilityRouter.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    }
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

    const date = new Date(`${dateStr}T00:00:00.000Z`);
    const mark = await prisma.availabilityMark.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, type: type as 'UNAVAILABLE' | 'PREFERRED_OFF', note },
      update: { type: type as 'UNAVAILABLE' | 'PREFERRED_OFF', note },
    });
    return res.status(201).json({ id: mark.id, date: mark.date.toISOString().slice(0, 10), type: mark.type, note: mark.note });
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
