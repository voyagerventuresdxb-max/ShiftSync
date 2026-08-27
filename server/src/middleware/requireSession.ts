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

/** Resolves the `Authorization: Bearer <token>` header to a real User, or 401s. */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return res.status(401).json({ error: 'Missing or malformed Authorization header.' });

  const user = await resolveSession(token);
  if (!user) return res.status(401).json({ error: 'Session is invalid or has expired.' });

  req.user = user;
  next();
}
