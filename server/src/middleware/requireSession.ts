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

// Deterministically exercises the catch branch below for regression tests.
// The actual failure this guards against (an unexpected thrown error inside
// session-auth middleware — a DB hiccup, a stale session row racing a
// concurrent delete) is real but not reliably forceable from outside the
// process, so this is a narrow, off-by-default trigger for it — same
// dev-only-env-flag shape as ALLOW_DEV_OTP_ECHO elsewhere in this codebase,
// never armed unless explicitly opted into, and inert for every real token
// (a real session token is 64 hex chars; this sentinel isn't a valid shape).
const ALLOW_DEV_ERROR_INJECTION = process.env.ALLOW_DEV_ERROR_INJECTION === 'true';
const DEV_ERROR_INJECTION_TOKEN = '__test-inject-requiresession-error__';

/**
 * Resolves the `Authorization: Bearer <token>` header to a real User, or
 * 401s. Wrapped in try/catch and forwarded via `next(err)` rather than left
 * to reject bare — Express 4 does not auto-catch a rejected promise from
 * middleware, so an unexpected error here (a DB hiccup, a stale session row
 * racing a concurrent delete) would otherwise become an unhandled rejection
 * that crashes the whole process for every connected user, not just fail
 * this one request. `next(err)` routes it to app.ts's existing error
 * handler instead, matching how Multer's errors already surface.
 */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Missing or malformed Authorization header.' });

    if (ALLOW_DEV_ERROR_INJECTION && token === DEV_ERROR_INJECTION_TOKEN) {
      throw new Error('Deliberate test-injected error (ALLOW_DEV_ERROR_INJECTION).');
    }

    const user = await resolveSession(token);
    if (!user) return res.status(401).json({ error: 'Session is invalid or has expired.' });

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
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
  // Positive allowlist, not `=== 'STAFF'`: any role this check doesn't know
  // about (a future enum value, a malformed row) is refused, not waved through.
  if (!isManagerRole(req.user.systemRole)) {
    return res.status(403).json({ error: 'This action requires a manager or owner account.' });
  }
  next();
}

/** True only for the manager tier (OWNER/MANAGER). Fail-closed: anything else — STAFF or an unknown value — is false. */
export function isManagerRole(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

/**
 * Like `requireSession`, but never rejects: a valid bearer token sets
 * `req.user`, a missing/invalid/expired one leaves it unset and the request
 * proceeds as anonymous. For reads that serve both the anonymous kiosk and
 * signed-in users with different visibility (e.g. drafts for managers only)
 * — the handler MUST treat an unset `req.user` as the least-privileged case.
 */
export async function optionalSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearerToken(req);
    if (token) {
      const user = await resolveSession(token);
      if (user) req.user = user;
    }
    next();
  } catch (err) {
    next(err);
  }
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
