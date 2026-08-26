import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

/**
 * Staff Directory — a venue-configured mapping of each staff member to
 * their actual job title (e.g. "Restaurant Manager", "Assistant
 * Restaurant Manager"). Set manually by the venue once via this simple
 * CRUD API, never inferred from an uploaded roster. This is what the
 * roster grid's Management tier cross-references against, independent of
 * whatever role (if any) a given upload resolved for that person.
 */
export const staffDirectoryRouter = Router();

/** GET /api/staff-directory/:locationId — list active staff for a location. */
staffDirectoryRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const users = await prisma.user.findMany({
      where: { locationId, isActive: true },
      orderBy: { fullName: 'asc' },
      include: { role: true },
    });
    return res.status(200).json({
      staff: users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        jobTitle: u.jobTitle,
        roleName: u.role?.name ?? null,
      })),
    });
  } catch (err) {
    console.error('[staffDirectory.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the staff directory.' });
  }
});

/** POST /api/staff-directory — add a new staff member. body: { locationId, fullName, jobTitle? } */
staffDirectoryRouter.post('/', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const fullName = String(req.body?.fullName ?? '').trim();
    const jobTitle = req.body?.jobTitle ? String(req.body.jobTitle).trim() : null;
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!fullName) return res.status(400).json({ error: 'fullName is required.' });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const user = await prisma.user.create({
      data: { locationId, fullName, jobTitle },
    });
    return res.status(201).json({ id: user.id, fullName: user.fullName, jobTitle: user.jobTitle, roleName: null });
  } catch (err) {
    console.error('[staffDirectory.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while adding the staff member.' });
  }
});

/** PATCH /api/staff-directory/:userId — edit an existing staff member's name and/or job title. */
staffDirectoryRouter.patch('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const data: { fullName?: string; jobTitle?: string | null } = {};
    if (req.body?.fullName !== undefined) {
      const fullName = String(req.body.fullName).trim();
      if (!fullName) return res.status(400).json({ error: 'fullName cannot be empty.' });
      data.fullName = fullName;
    }
    if (req.body?.jobTitle !== undefined) {
      const jobTitle = req.body.jobTitle === null ? null : String(req.body.jobTitle).trim();
      data.jobTitle = jobTitle || null;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update — provide fullName and/or jobTitle.' });
    }

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) return res.status(404).json({ error: `Staff member "${userId}" not found.` });

    const user = await prisma.user.update({ where: { id: userId }, data, include: { role: true } });
    return res.status(200).json({ id: user.id, fullName: user.fullName, jobTitle: user.jobTitle, roleName: user.role?.name ?? null });
  } catch (err) {
    console.error('[staffDirectory.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating the staff member.' });
  }
});
