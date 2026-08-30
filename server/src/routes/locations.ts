import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager } from '../middleware/requireSession.js';

export const locationsRouter = Router();

/**
 * Options offered by the onboarding wizard's venue-type card picker.
 * `venueType` itself is a free-text column (not a Prisma enum, same
 * shallow-additive pattern as FloorSection.notes) — this list is enforced
 * here at the API boundary instead.
 */
export const VENUE_TYPES = [
  'Fine Dining',
  'Bar / Lounge',
  'Nightclub',
  'Rooftop / Beach Club',
  'Hotel F&B Outlet',
  'Café / Bakery',
] as const;

/** GET /api/locations/:id — any authenticated session, own venue only. */
locationsRouter.get('/:id', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    if (id !== req.user!.locationId) {
      return res.status(403).json({ error: 'You do not have access to this location.' });
    }
    const location = await prisma.location.findUnique({
      where: { id },
      select: { id: true, name: true, venueType: true },
    });
    if (!location) return res.status(404).json({ error: `Location "${id}" not found.` });
    return res.status(200).json({ location });
  } catch (err) {
    console.error('[locations.get] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the venue.' });
  }
});

/**
 * PATCH /api/locations/:id — body: { name?, venueType? }
 * Used by the onboarding wizard's venue-setup step; either field may be
 * sent alone so a later edit doesn't clobber the other. Manager/owner-only,
 * own venue only.
 */
locationsRouter.patch('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    if (id !== req.user!.locationId) {
      return res.status(403).json({ error: 'You do not have access to this location.' });
    }
    const existing = await prisma.location.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Location "${id}" not found.` });

    const data: { name?: string; venueType?: string | null } = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty.' });
      data.name = name;
    }
    if (req.body?.venueType !== undefined) {
      const venueType = req.body.venueType === null ? null : String(req.body.venueType).trim();
      if (venueType && !(VENUE_TYPES as readonly string[]).includes(venueType)) {
        return res.status(400).json({ error: `venueType must be one of: ${VENUE_TYPES.join(', ')}.` });
      }
      data.venueType = venueType || null;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const location = await prisma.location.update({
      where: { id },
      data,
      select: { id: true, name: true, venueType: true },
    });
    return res.status(200).json({ location });
  } catch (err) {
    console.error('[locations.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating the venue.' });
  }
});
