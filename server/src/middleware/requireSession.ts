import type { Request, Response, NextFunction } from 'express';
import type { User } from '@prisma/client';
import { resolveSession } from '../lib/identity.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Extracts the raw bearer token from an `Authorization: Bearer <token>`
 * header, or null if absent/malformed. Exported so a handler that needs the
 * TOKEN itself (not just the resolved `req.user`) — e.g. session revocation
 * on sign-out — can read it without re-implementing the parsing.
 */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

/** Resolves the `Authorization: Bearer <token>` header to a real User, or 401s. */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Missing or malformed Authorization header.' });

  const user = await resolveSession(token);
  if (!user) return res.status(401).json({ error: 'Session is invalid or has expired.' });

  req.user = user;
  next();
}

/**
 * Gates a route to MANAGER/OWNER sessions only. MUST run after `requireSession`
 * (reads `req.user`, does not resolve it itself) — mirrors the STAFF-vs-everyone-else
 * binary `voice/intentSchema.ts`'s `allowedIntentsFor` already uses ("nothing else in
 * this codebase differentiates OWNER and MANAGER"), applied here to the legacy REST
 * routes (swap/join decide, staff directory and floor-plan mutations) that voice.ts's
 * own role check never covered.
 */
export function requireManager(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  if (req.user.systemRole === 'STAFF') {
    return res.status(403).json({ error: 'This action requires a manager or owner account.' });
  }
  next();
}

/**
 * 403s a route whose resource id comes directly from the request (a URL
 * param or body field), not a looked-up entity, when it doesn't match the
 * caller's own venue. MUST run after `requireSession`. Consolidates what
 * was ~11 hand-repeated copies of this exact check across `locations.ts`,
 * `staffDirectory.ts`, `swapRequests.ts`, `floorPlan.ts`, `shifts.ts`, and
 * `join.ts` (2026-08-31 tech-debt consolidation — see MEMORY.md) into one
 * place, so a future mutation route can't drop the check by omission.
 * Returns whether the caller may proceed; a `false` return has already sent
 * the 403.
 */
export function assertOwnsLocation(req: Request, res: Response, locationId: string): boolean {
  if (locationId !== req.user!.locationId) {
    res.status(403).json({ error: 'You do not have access to this location.' });
    return false;
  }
  return true;
}

/**
 * 404s a route whose resource was looked up by id, when either the lookup
 * found nothing OR the entity belongs to a different venue — the same 404
 * either way, on purpose: a 403 here would leak "this id exists, just isn't
 * yours" to a caller probing another tenant's ids. A type predicate, so a
 * passing call narrows `entity` to non-null for the rest of the handler.
 * MUST run after `requireSession`. Same consolidation as
 * `assertOwnsLocation`, above, for its sibling pattern.
 */
export function ownedOrNotFound<T extends { locationId: string }>(
  req: Request,
  res: Response,
  entity: T | null,
  notFoundMessage: string,
): entity is T {
  if (!entity || entity.locationId !== req.user!.locationId) {
    res.status(404).json({ error: notFoundMessage });
    return false;
  }
  return true;
}
