import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { ensureActiveInviteLink, presentInviteLink } from '../lib/inviteLinks.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';

export const onboardingRouter = Router();

/**
 * GET /api/onboarding/:locationId/invite
 * Returns the venue's active invite link (`/join?invite=<token>`, see
 * lib/inviteLinks.ts) with its QR code, creating one (30 days, unlimited
 * uses) only if none is active — so repeat calls return the same link.
 * Session-gated + manager-only (2026-08-31 — see MEMORY.md) so a random
 * anonymous caller can't harvest a live QR/WhatsApp invite for any venue by
 * guessing a locationId.
 */
onboardingRouter.get('/:locationId/invite', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const link = await ensureActiveInviteLink(locationId, req.user!.id);
    return res.status(200).json(await presentInviteLink(link, location.name, req.query.baseUrl));
  } catch (err) {
    console.error('[onboarding.invite] failed', err);
    return res.status(500).json({ error: 'Unexpected error while generating the invite link.' });
  }
});
