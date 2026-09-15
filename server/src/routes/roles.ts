import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';

export const rolesRouter = Router();

/**
 * GET /api/roles — active Role rows for the caller's own venue (id + name).
 * Read-only, any authenticated session. Used by the onboarding Review
 * screen's role-chip selector so a venue's previously-added custom roles
 * (created on an earlier confirm — see schedules.ts's confirm endpoint)
 * show up as real, reusable chips alongside the 9 canonical labels, not
 * just for the session that created them.
 */
rolesRouter.get('/', requireSession, async (req, res) => {
  try {
    const roles = await prisma.role.findMany({
      where: { locationId: req.user!.locationId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return res.status(200).json({ roles });
  } catch (err) {
    console.error('[roles.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading roles.' });
  }
});
