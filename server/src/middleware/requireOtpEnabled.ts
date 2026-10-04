import type { NextFunction, Request, Response } from 'express';
import { otpLoginEnabled } from '../lib/loginLinks.js';

/**
 * Only with an explicit LOGIN_METHODS=links are the phone-code routes closed,
 * server-side rather than merely hidden in the UI. The default keeps them on.
 * Read per request so tests can flip the mode without restarting.
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
