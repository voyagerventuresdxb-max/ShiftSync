import type { NextFunction, Request, Response } from 'express';
import { otpLoginEnabled } from '../lib/loginLinks.js';

/**
 * With LOGIN_METHODS=links (the default) the phone-code routes are closed
 * server-side, not merely hidden in the UI — otherwise anyone who knew the
 * endpoint could still request codes for any phone number. Read per request
 * so tests can flip the mode without restarting.
 */
export function requireOtpEnabled(_req: Request, res: Response, next: NextFunction) {
  if (!otpLoginEnabled()) {
    return res.status(403).json({
      error: 'Phone-code login is switched off. Ask your manager for a login link instead.',
      errorCode: 'otp_disabled',
    });
  }
  next();
}
