import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { generateQrDataUrl } from '../lib/qrCode.js';

export const onboardingRouter = Router();

/**
 * GET /api/onboarding/:locationId/invite
 * Mints the venue's Join-flow invite link and its QR code. The link itself
 * needs no token/expiry — Join's own phone+OTP verification is the real
 * gate; this is just a convenient, shareable pointer to /join.
 */
onboardingRouter.get('/:locationId/invite', async (req, res) => {
  try {
    const { locationId } = req.params;
    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const baseUrl = String(req.query.baseUrl ?? `${req.protocol}://${req.get('host')}`);
    const inviteUrl = `${baseUrl}/join?location=${locationId}`;
    const qrDataUrl = await generateQrDataUrl(inviteUrl);
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`You've been added to ${location.name}'s team on ShiftSync. Join here: ${inviteUrl}`)}`;

    return res.status(200).json({ inviteUrl, qrDataUrl, whatsappUrl });
  } catch (err) {
    console.error('[onboarding.invite] failed', err);
    return res.status(500).json({ error: 'Unexpected error while generating the invite link.' });
  }
});
