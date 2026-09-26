import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { generateQrDataUrl } from '../lib/qrCode.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';
import { getAllowedFrontendOrigins } from '../lib/frontendOrigins.js';

export const onboardingRouter = Router();

/**
 * The client-supplied `baseUrl` is only ever used as a display convenience
 * (so invite links point at the app the manager is actually using, not this
 * API's own host — see the 2026-09-15 fix below). It must never be trusted
 * verbatim: a compromised or forged client could otherwise mint a QR/WhatsApp
 * invite pointing at an attacker-controlled domain. Only an origin present in
 * the server-side allowlist is honored; anything else (including no value at
 * all) falls back to the first configured/default origin.
 */
function resolveInviteBaseUrl(requestedBaseUrl: unknown): string {
  const allowed = getAllowedFrontendOrigins();
  const requested = typeof requestedBaseUrl === 'string' ? requestedBaseUrl.replace(/\/+$/, '') : undefined;
  return requested && allowed.includes(requested) ? requested : allowed[0];
}

/**
 * GET /api/onboarding/:locationId/invite
 * Mints the venue's Join-flow invite link and its QR code. The link itself
 * needs no token/expiry — Join's own phone+OTP verification is the real
 * gate; this is just a convenient, shareable pointer to /join. The endpoint
 * that MINTS it is a different matter: session-gated + manager-only
 * (2026-08-31 — see MEMORY.md) so a random anonymous caller can't harvest a
 * live QR/WhatsApp invite for any venue by guessing a locationId — the
 * client (`OnboardingWizard.tsx`, already behind `/onboarding`'s
 * `RequireSession managerOnly` gate) simply wasn't sending its own
 * already-available token, an oversight this closes rather than a
 * previously-deliberate choice (no comment on record justified it).
 */
onboardingRouter.get('/:locationId/invite', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const baseUrl = resolveInviteBaseUrl(req.query.baseUrl);
    const inviteUrl = `${baseUrl}/join?location=${locationId}`;
    const qrDataUrl = await generateQrDataUrl(inviteUrl);
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`You've been added to ${location.name}'s team on ShiftSync. Join here: ${inviteUrl}`)}`;

    return res.status(200).json({ inviteUrl, qrDataUrl, whatsappUrl });
  } catch (err) {
    console.error('[onboarding.invite] failed', err);
    return res.status(500).json({ error: 'Unexpected error while generating the invite link.' });
  }
});
