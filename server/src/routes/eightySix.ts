import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { requireSession, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';

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
 *
 * Active and resolved items are fetched as two queries rather than one,
 * because each group's meaningful recency is a *different* column: an active
 * item is "most recently 86'd", a resolved one is "most recently back on"
 * (which is what the client's "Recently back on" heading promises). A single
 * `orderBy: [status, backOnAt, eightySixedAt]` would happen to work today
 * only because every EIGHTY_SIXED row has a null backOnAt — an invariant
 * nothing in the schema enforces. Active always comes first in the response,
 * preserving the previous `status: 'asc'` group order.
 *
 * Session-gated (2026-08-31 — see MEMORY.md): unlike `shifts.ts`, this
 * route has no anonymous/kiosk consumer to preserve — `EightySixBoard` only
 * ever renders inside `/floor-plan`, already behind `RequireSession` — so
 * there was no reason for the read to stay open either.
 */
eightySixRouter.get('/:locationId', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const includeResolved = req.query.includeResolved === '1';

    const active = await prisma.eightySixItem.findMany({
      where: { locationId, status: 'EIGHTY_SIXED' },
      orderBy: { eightySixedAt: 'desc' },
    });
    const resolved = includeResolved
      ? await prisma.eightySixItem.findMany({
          where: { locationId, status: 'BACK_ON' },
          orderBy: { backOnAt: 'desc' },
        })
      : [];

    const items = [...active, ...resolved];
    return res.status(200).json({ items: items.map(itemToDto) });
  } catch (err) {
    console.error('[eightySix.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the 86 list.' });
  }
});

/**
 * POST /api/eighty-six — body: { itemName, station, note?, createdById? }
 * Session-gated; `locationId` comes from the session, not the body.
 * `createdById` is only honored for a MANAGER/OWNER session (same
 * "Viewing" on-behalf-of pattern as `shifts.ts`'s POST /, above it) — a
 * STAFF session is always attributed as itself.
 */
eightySixRouter.post('/', requireSession, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const itemName = String(req.body?.itemName ?? '').trim();
    const station = String(req.body?.station ?? '').trim();
    const note = req.body?.note ? String(req.body.note).trim() : null;
    const createdById =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.createdById ? String(req.body.createdById).trim() : '') || req.user!.id;

    if (!itemName) return res.status(400).json({ error: 'itemName is required.' });
    if (!station) return res.status(400).json({ error: 'station is required.' });

    const item = await withAuditedTransaction(
      prisma,
      (tx) =>
        tx.eightySixItem.create({
          data: { locationId, itemName, station, note, createdById },
        }),
      (created) => ({
        locationId,
        actorId: createdById,
        shiftId: null,
        action: 'ITEM_86D',
        entityType: 'EightySixItem',
        entityId: created.id,
        note: `86'd "${itemName}" (${station})`,
      }),
    );

    return res.status(201).json({ item: itemToDto(item) });
  } catch (err) {
    console.error('[eightySix.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while 86-ing the item.' });
  }
});

/**
 * PATCH /api/eighty-six/:itemId/back-on — body: { actorId? }
 * Session-gated; `actorId` in the body is only honored for a MANAGER/OWNER
 * session — same on-behalf-of rule as POST /, above.
 */
eightySixRouter.patch('/:itemId/back-on', requireSession, async (req, res) => {
  try {
    const { itemId } = req.params;
    const existing = await prisma.eightySixItem.findUnique({ where: { id: itemId } });
    if (!ownedOrNotFound(req, res, existing, `Item "${itemId}" not found.`)) return;
    if (existing.status === 'BACK_ON') {
      return res.status(409).json({ error: 'This item is already back on.' });
    }

    const backOnById =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.actorId ? String(req.body.actorId).trim() : '') || req.user!.id;
    const item = await withAuditedTransaction(
      prisma,
      (tx) =>
        tx.eightySixItem.update({
          where: { id: itemId },
          data: { status: 'BACK_ON', backOnAt: new Date(), backOnById },
        }),
      (updated) => ({
        locationId: existing.locationId,
        actorId: backOnById,
        shiftId: null,
        action: 'ITEM_BACK_ON',
        entityType: 'EightySixItem',
        entityId: updated.id,
        note: `"${existing.itemName}" back on (${existing.station})`,
      }),
    );

    return res.status(200).json({ item: itemToDto(item) });
  } catch (err) {
    console.error('[eightySix.backOn] failed', err);
    return res.status(500).json({ error: 'Unexpected error while marking the item back on.' });
  }
});
