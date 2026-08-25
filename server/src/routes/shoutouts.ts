import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

export const shoutoutsRouter = Router();

/** GET /api/shoutouts/:locationId — newest first. */
shoutoutsRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const rows = await prisma.shoutout.findMany({
      where: { locationId },
      orderBy: { createdAt: 'desc' },
      include: { employee: { select: { fullName: true } }, author: { select: { fullName: true } } },
    });
    return res.status(200).json({
      shoutouts: rows.map((s) => ({
        id: s.id,
        employeeId: s.employeeId,
        employeeName: s.employee.fullName,
        authorId: s.authorId,
        authorName: s.author?.fullName ?? null,
        shiftSnapshot: s.shiftSnapshot,
        note: s.note,
        createdAt: s.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[shoutouts.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading shoutouts.' });
  }
});

/** POST /api/shoutouts — body: { locationId, employeeId, authorId?, shiftSnapshot?, note } */
shoutoutsRouter.post('/', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const employeeId = String(req.body?.employeeId ?? '').trim();
    const authorId = req.body?.authorId ? String(req.body.authorId).trim() : null;
    const shiftSnapshot = req.body?.shiftSnapshot ? String(req.body.shiftSnapshot).trim() : null;
    const note = String(req.body?.note ?? '').trim();

    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!employeeId) return res.status(400).json({ error: 'employeeId is required.' });
    if (!note) return res.status(400).json({ error: 'note is required.' });

    const employee = await prisma.user.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: `Staff member "${employeeId}" not found.` });

    const created = await prisma.shoutout.create({
      data: { locationId, employeeId, authorId, shiftSnapshot, note },
      include: { employee: { select: { fullName: true } }, author: { select: { fullName: true } } },
    });
    return res.status(201).json({
      shoutout: {
        id: created.id,
        employeeId: created.employeeId,
        employeeName: created.employee.fullName,
        authorId: created.authorId,
        authorName: created.author?.fullName ?? null,
        shiftSnapshot: created.shiftSnapshot,
        note: created.note,
        createdAt: created.createdAt.toISOString(),
      },
    });
  } catch (err) {
    console.error('[shoutouts.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the shoutout.' });
  }
});
