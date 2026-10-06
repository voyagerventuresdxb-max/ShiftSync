import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';
import { VENUE_TYPES } from '../../../shared/venueTypes.js';
import { VENUE_NAME_MAX_LENGTH } from '../../../shared/venueName.js';

export const locationsRouter = Router();

/** GET /api/locations/:id — any authenticated session, own venue only. */
locationsRouter.get('/:id', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    if (!assertOwnsLocation(req, res, id)) return;
    const location = await prisma.location.findUnique({
      where: { id },
      select: { id: true, name: true, venueType: true, emirate: true },
    });
    if (!location) return res.status(404).json({ error: `Location "${id}" not found.` });
    return res.status(200).json({ location });
  } catch (err) {
    console.error('[locations.get] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the venue.' });
  }
});

/**
 * PATCH /api/locations/:id — body: { name?, venueType?, emirate? }
 * Used by the onboarding wizard's venue-setup step and the Venue panel on
 * Profile (rename); any field may be sent alone so a later edit doesn't
 * clobber the others. `name` is trimmed, non-empty and at most
 * VENUE_NAME_MAX_LENGTH characters. Manager/owner-only,
 * own venue only. `emirate` is free-text (the Prisma column has no enum —
 * see its schema comment), same trim-only treatment as `name`; the onboarding
 * UI's city chips (Dubai/Abu Dhabi/Sharjah/Other) are a client-side
 * convenience, not a server-enforced list.
 */
locationsRouter.patch('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    if (!assertOwnsLocation(req, res, id)) return;
    const existing = await prisma.location.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Location "${id}" not found.` });

    const data: { name?: string; venueType?: string | null; emirate?: string | null } = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty.' });
      if (name.length > VENUE_NAME_MAX_LENGTH) {
        return res.status(400).json({ error: `name must be ${VENUE_NAME_MAX_LENGTH} characters or fewer.` });
      }
      data.name = name;
    }
    if (req.body?.venueType !== undefined) {
      const venueType = req.body.venueType === null ? null : String(req.body.venueType).trim();
      if (venueType && !(VENUE_TYPES as readonly string[]).includes(venueType)) {
        return res.status(400).json({ error: `venueType must be one of: ${VENUE_TYPES.join(', ')}.` });
      }
      data.venueType = venueType || null;
    }
    if (req.body?.emirate !== undefined) {
      const emirate = req.body.emirate === null ? null : String(req.body.emirate).trim();
      data.emirate = emirate || null;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const location = await prisma.$transaction(async (tx) => {
      const updated = await tx.location.update({
        where: { id },
        data,
        select: { id: true, name: true, venueType: true, emirate: true },
      });
      // Location.name is the one venue name every screen reads. Signup also
      // copies it into Organization.name, which nothing displays — it is read
      // only by test-venue cleanup (lib/testVenueCleanup.ts, e2e helpers),
      // which matches test orgs by name prefix. While the organization has
      // exactly this one location, the two names mean the same thing, so a
      // rename keeps them in step (here, in the same transaction) rather than
      // leaving the signup-time name behind. Once an organization has several
      // locations, its name is the group's own and a venue rename leaves it
      // alone. Consequence for test venues: a rename that drops the test
      // prefix also takes the org out of reach of the cleanup.
      if (data.name !== undefined) {
        await tx.organization.updateMany({
          where: { id: existing.organizationId, locations: { every: { id } } },
          data: { name: data.name },
        });
      }
      return updated;
    });
    return res.status(200).json({ location });
  } catch (err) {
    console.error('[locations.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating the venue.' });
  }
});
