import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import { getAllowedFrontendOrigins } from '../lib/frontendOrigins.js';

/**
 * CORS locked to the configured frontend origin(s) — see
 * lib/frontendOrigins.ts. Two deliberate differences from a bare
 * `cors({ origin })`:
 *
 * 1. A request that carries an `Origin` header NOT on the allowlist is
 *    answered 403 outright. The `cors` package on its own never blocks
 *    anything — it only withholds the `Access-Control-Allow-Origin` header
 *    and lets the request through to the handler, so a cross-site POST to
 *    /api/identity/request-otp would still run (the browser hides the
 *    response, but the side effect — a code minted, an SMS someday sent —
 *    already happened).
 * 2. A request with NO `Origin` header passes through untouched. Browsers
 *    omit it on same-origin GETs, and non-browser callers (Railway's
 *    health check, curl, the Vercel rewrite for same-origin navigations)
 *    never send one — none of those are the cross-site case CORS exists
 *    to stop.
 *
 * The allowlist is read per request so tests can reconfigure
 * FRONTEND_ORIGIN without restarting the process.
 */
export function frontendCors() {
  const delegate = cors({
    origin: (origin, callback) => callback(null, !origin || getAllowedFrontendOrigins().includes(origin)),
  });

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !getAllowedFrontendOrigins().includes(origin)) {
      return res.status(403).json({ error: 'Origin not allowed.' });
    }
    return delegate(req, res, next);
  };
}
