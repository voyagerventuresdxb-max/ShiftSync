import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, ownedOrNotFound } from '../middleware/requireSession.js';

export const rolesRouter = Router();

/** Role rows are unique on (locationId, name); this finds a same-named row whether or not it is still active. */
async function findSameName(locationId: string, name: string) {
  return prisma.role.findUnique({ where: { locationId_name: { locationId, name } } });
}

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

/**
 * POST /api/roles — body: { name }. Manager/owner only, own venue.
 * A venue starts with shared/defaultRoles.ts seeded at signup and grows its
 * own vocabulary from here (and from roster confirms). Re-adding a name that
 * was removed earlier reactivates the same row (its shifts still point at
 * it) rather than colliding with the (locationId, name) unique index.
 */
rolesRouter.post('/', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const existing = await findSameName(locationId, name);
    if (existing?.isActive) return res.status(409).json({ error: `A role named "${name}" already exists.` });
    const role = existing
      ? await prisma.role.update({ where: { id: existing.id }, data: { isActive: true }, select: { id: true, name: true } })
      : await prisma.role.create({ data: { locationId, name }, select: { id: true, name: true } });
    return res.status(existing ? 200 : 201).json({ role });
  } catch (err) {
    console.error('[roles.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while adding the role.' });
  }
});

/**
 * PATCH /api/roles/:id — body: { name }. Rename. Manager/owner only, own
 * venue. Every shift and staff record referencing the role follows the new
 * name automatically (they hold the id, not the text).
 */
rolesRouter.patch('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const existing = await prisma.role.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Role "${id}" not found.`)) return;
    const clash = await findSameName(existing.locationId, name);
    if (clash && clash.id !== id) return res.status(409).json({ error: `A role named "${name}" already exists.` });

    const role = await prisma.role.update({ where: { id }, data: { name }, select: { id: true, name: true } });
    return res.status(200).json({ role });
  } catch (err) {
    console.error('[roles.rename] failed', err);
    return res.status(500).json({ error: 'Unexpected error while renaming the role.' });
  }
});

/**
 * DELETE /api/roles/:id — remove a role from the venue's vocabulary.
 * Manager/owner only, own venue. Deactivates rather than deleting: `Shift`
 * requires a role, so existing shifts keep theirs (still labelled, still
 * editable) and nothing is orphaned; staff currently on the role are
 * unassigned so the directory and the rota builder stop offering it; new
 * shifts can no longer be created on it (see shifts.ts's POST).
 */
rolesRouter.delete('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.role.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Role "${id}" not found.`)) return;
    await prisma.$transaction([
      prisma.user.updateMany({ where: { roleId: id }, data: { roleId: null } }),
      prisma.role.update({ where: { id }, data: { isActive: false } }),
    ]);
    return res.status(204).send();
  } catch (err) {
    console.error('[roles.remove] failed', err);
    return res.status(500).json({ error: 'Unexpected error while removing the role.' });
  }
});
