import type { Request, Response, NextFunction } from 'express';
import { requireSession, assertOwnsLocation } from './requireSession.js';
import { kioskFailureLimiter } from './rateLimit.js';
import { isCurrentKioskToken } from '../lib/kioskLinks.js';
import { KIOSK_TOKEN_HEADER } from '../../../shared/kioskLinks.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set when the venue's kiosk token (no session) admitted the request: the route answers with its kiosk view. */
      kioskLocationId?: string;
    }
  }
}

/** One answer for every refused kiosk read: no token, a wrong one, a replaced one or a revoked one. */
const KIOSK_REFUSED = { error: 'This screen needs a current kiosk link — ask a manager to share it again.', errorCode: 'kiosk_link_required' };

/**
 * Gate for the venue reads a kiosk screen makes — `GET /api/shifts/:locationId`,
 * `GET /api/shifts/:locationId/publish-status`, `GET /api/announcements/:locationId`,
 * `GET /api/shoutouts/:locationId` and (rota builder v2) `GET /api/weeks/:locationId/:weekStart`,
 * which answers a kiosk with the published view — and for no other route.
 *
 * With an Authorization header: a session of THAT venue (`requireSession` +
 * `assertOwnsLocation`, so another venue's session gets 403). Without one: the
 * venue's current kiosk token in `X-Kiosk-Token`, which sets
 * `req.kioskLocationId` so the route returns its reduced kiosk view. A venue
 * id alone, or any token that isn't the venue's current one, gets the same
 * 401; only those refusals count toward `kioskFailureLimiter`.
 */
export async function requireSessionOrKioskToken(req: Request, res: Response, next: NextFunction) {
  const { locationId } = req.params;
  if (req.headers.authorization) {
    return requireSession(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (assertOwnsLocation(req, res, locationId)) next();
    });
  }
  try {
    if (await isCurrentKioskToken(locationId, req.get(KIOSK_TOKEN_HEADER) ?? '')) {
      req.kioskLocationId = locationId;
      return next();
    }
    kioskFailureLimiter(req, res, () => res.status(401).json(KIOSK_REFUSED));
  } catch (err) {
    next(err);
  }
}
