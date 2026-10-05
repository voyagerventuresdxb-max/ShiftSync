import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { buildKioskUrl, regenerateKioskToken, revokeKioskToken } from '../lib/kioskLinks.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';

/**
 * Manager-only: view, regenerate and revoke the caller's own venue's kiosk
 * link. Only regenerate returns the link (once); the status read never
 * includes it. `?baseUrl=` picks the link's origin (allowlisted, as for invite links).
 */
export const kioskRouter = Router();

/** GET /api/kiosk/:locationId → { active: { createdAt } | null } */
kioskRouter.get('/:locationId', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const location = await prisma.location.findUnique({ where: { id: locationId }, select: { kioskTokenCreatedAt: true } });
    const createdAt = location?.kioskTokenCreatedAt;
    return res.status(200).json({ active: createdAt ? { createdAt: createdAt.toISOString() } : null });
  } catch (err) {
    console.error('[kiosk.get] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the kiosk link.' });
  }
});

/** POST /api/kiosk/:locationId/regenerate → { active: { createdAt }, url }. The previous link stops working. */
kioskRouter.post('/:locationId/regenerate', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const { token, createdAt } = await regenerateKioskToken(locationId);
    return res.status(201).json({ active: { createdAt: createdAt.toISOString() }, url: buildKioskUrl(locationId, token, req.query.baseUrl) });
  } catch (err) {
    console.error('[kiosk.regenerate] failed', err);
    return res.status(500).json({ error: 'Unexpected error while creating a new kiosk link.' });
  }
});

/** POST /api/kiosk/:locationId/revoke → { active: null }. No kiosk link works for the venue afterwards. */
kioskRouter.post('/:locationId/revoke', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    await revokeKioskToken(locationId);
    return res.status(200).json({ active: null });
  } catch (err) {
    console.error('[kiosk.revoke] failed', err);
    return res.status(500).json({ error: 'Unexpected error while revoking the kiosk link.' });
  }
});
