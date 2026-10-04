import type { Request, Response } from 'express';
import { prisma } from './prisma.js';
import { ownedOrNotFound } from '../middleware/requireSession.js';

/**
 * Who an action is recorded against: the caller, or — for a manager/owner
 * session only — the colleague named in `req.body[field]`, who must be a
 * person at the caller's own venue. Anyone else answers 404 (sent here) and
 * returns null, so a record or audit row never names another venue's person
 * (same rule `policyDocuments.ts` applies to `uploadedById`).
 */
export async function onBehalfUserId(req: Request, res: Response, field: string): Promise<string | null> {
  const named = req.user!.systemRole === 'STAFF' ? '' : String(req.body?.[field] ?? '').trim();
  if (!named || named === req.user!.id) return req.user!.id;
  const user = await prisma.user.findUnique({ where: { id: named } });
  return ownedOrNotFound(req, res, user, `Staff member "${named}" not found.`) ? named : null;
}
