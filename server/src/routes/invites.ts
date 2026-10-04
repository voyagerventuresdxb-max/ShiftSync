import { Router, type Request, type Response } from 'express';
import type { Location } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  findActiveInviteLink,
  parseInviteLinkOptions,
  presentInviteLink,
  regenerateInviteLink,
  revokeInviteLinks,
} from '../lib/inviteLinks.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';

/** Manager-only: view, regenerate and revoke the caller's own venue's invite link. `?baseUrl=` picks the link's origin (allowlisted). */
export const invitesRouter = Router();

async function ownLocation(req: Request, res: Response): Promise<Location | null> {
  const { locationId } = req.params;
  if (!assertOwnsLocation(req, res, locationId)) return null;
  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location) res.status(404).json({ error: `Location "${locationId}" not found.` });
  return location;
}

/** GET /api/invites/:locationId → { active: {...} | null } */
invitesRouter.get('/:locationId', requireSession, requireManager, async (req, res) => {
  try {
    const location = await ownLocation(req, res);
    if (!location) return;
    const link = await findActiveInviteLink(prisma, location.id);
    return res.status(200).json({ active: link ? await presentInviteLink(link, location.name, req.query.baseUrl) : null });
  } catch (err) {
    console.error('[invites.get] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the invite link.' });
  }
});

/** POST /api/invites/:locationId/regenerate — body: { expiresInDays?: 1–90, maxUses?: null | 1–1000 }. Revokes the old link. */
invitesRouter.post('/:locationId/regenerate', requireSession, requireManager, async (req, res) => {
  try {
    const location = await ownLocation(req, res);
    if (!location) return;
    const opts = parseInviteLinkOptions(req.body);
    if ('error' in opts) return res.status(400).json({ error: opts.error });
    const link = await regenerateInviteLink(location.id, req.user!.id, opts);
    return res.status(201).json({ active: await presentInviteLink(link, location.name, req.query.baseUrl) });
  } catch (err) {
    console.error('[invites.regenerate] failed', err);
    return res.status(500).json({ error: 'Unexpected error while creating a new invite link.' });
  }
});

/** POST /api/invites/:locationId/revoke → { active: null, revoked: n } */
invitesRouter.post('/:locationId/revoke', requireSession, requireManager, async (req, res) => {
  try {
    const location = await ownLocation(req, res);
    if (!location) return;
    const revoked = await revokeInviteLinks(location.id, req.user!.id);
    return res.status(200).json({ active: null, revoked });
  } catch (err) {
    console.error('[invites.revoke] failed', err);
    return res.status(500).json({ error: 'Unexpected error while revoking the invite link.' });
  }
});
