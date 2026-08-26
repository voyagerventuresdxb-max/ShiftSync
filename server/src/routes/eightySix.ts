import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

export const eightySixRouter = Router();

function itemToDto(item: {
  id: string;
  itemName: string;
  station: string;
  status: string;
  note: string | null;
  eightySixedAt: Date;
  backOnAt: Date | null;
}) {
  return {
    id: item.id,
    itemName: item.itemName,
    station: item.station,
    status: item.status as 'EIGHTY_SIXED' | 'BACK_ON',
    note: item.note,
    eightySixedAt: item.eightySixedAt.toISOString(),
    backOnAt: item.backOnAt ? item.backOnAt.toISOString() : null,
  };
}

/**
 * GET /api/eighty-six/:locationId?includeResolved=1
 * Active (EIGHTY_SIXED) items always included; resolved (BACK_ON) items only
 * when includeResolved is set — the default view is "what's out right now."
 */
eightySixRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const includeResolved = req.query.includeResolved === '1';
    const items = await prisma.eightySixItem.findMany({
      where: includeResolved ? { locationId } : { locationId, status: 'EIGHTY_SIXED' },
      orderBy: [{ status: 'asc' }, { eightySixedAt: 'desc' }],
    });
    return res.status(200).json({ items: items.map(itemToDto) });
  } catch (err) {
    console.error('[eightySix.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the 86 list.' });
  }
});

/** POST /api/eighty-six — body: { locationId, itemName, station, note?, createdById? } */
eightySixRouter.post('/', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const itemName = String(req.body?.itemName ?? '').trim();
    const station = String(req.body?.station ?? '').trim();
    const note = req.body?.note ? String(req.body.note).trim() : null;
    const createdById = req.body?.createdById ? String(req.body.createdById).trim() : null;

    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!itemName) return res.status(400).json({ error: 'itemName is required.' });
    if (!station) return res.status(400).json({ error: 'station is required.' });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const item = await prisma.eightySixItem.create({
      data: { locationId, itemName, station, note, createdById },
    });

    await prisma.auditLog.create({
      data: {
        locationId,
        actorId: createdById,
        shiftId: null,
        action: 'ITEM_86D',
        entityType: 'EightySixItem',
        entityId: item.id,
        note: `86'd "${itemName}" (${station})`,
      },
    });

    return res.status(201).json({ item: itemToDto(item) });
  } catch (err) {
    console.error('[eightySix.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while 86-ing the item.' });
  }
});

/** PATCH /api/eighty-six/:itemId/back-on — body: { actorId? } */
eightySixRouter.patch('/:itemId/back-on', async (req, res) => {
  try {
    const { itemId } = req.params;
    const existing = await prisma.eightySixItem.findUnique({ where: { id: itemId } });
    if (!existing) return res.status(404).json({ error: `Item "${itemId}" not found.` });
    if (existing.status === 'BACK_ON') {
      return res.status(409).json({ error: 'This item is already back on.' });
    }

    const backOnById = req.body?.actorId ? String(req.body.actorId).trim() : null;
    const item = await prisma.eightySixItem.update({
      where: { id: itemId },
      data: { status: 'BACK_ON', backOnAt: new Date(), backOnById },
    });

    await prisma.auditLog.create({
      data: {
        locationId: existing.locationId,
        actorId: backOnById,
        shiftId: null,
        action: 'ITEM_BACK_ON',
        entityType: 'EightySixItem',
        entityId: item.id,
        note: `"${existing.itemName}" back on (${existing.station})`,
      },
    });

    return res.status(200).json({ item: itemToDto(item) });
  } catch (err) {
    console.error('[eightySix.backOn] failed', err);
    return res.status(500).json({ error: 'Unexpected error while marking the item back on.' });
  }
});
