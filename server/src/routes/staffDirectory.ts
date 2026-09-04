import { Router, type Request } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { writeAuditLog } from '../lib/auditLog.js';

/**
 * Staff Directory — a venue-configured mapping of each staff member to
 * their actual job title (e.g. "Restaurant Manager", "Assistant
 * Restaurant Manager"). Set manually by the venue once via this simple
 * CRUD API, never inferred from an uploaded roster. This is what the
 * roster grid's Management tier cross-references against, independent of
 * whatever role (if any) a given upload resolved for that person.
 *
 * Extended to also carry phone, preferred language, start date (hiredAt),
 * employment status (isActive), and a read-only venue name (joined from
 * Location.name) — see the 2026-08-28 People/Identity plan, Task 5.
 */
export const staffDirectoryRouter = Router();

/** The one place "does this caller get personal fields?" is decided — every route derives `redactPersonal` from this, never a literal. */
function redactPersonalFor(req: Request): boolean {
  return req.user!.systemRole === 'STAFF';
}

/**
 * Shape shared by GET/POST/PATCH responses below.
 * `redactPersonal` nulls phone/preferredLanguage/hiredAt/terminatedAt for STAFF
 * callers (no STAFF-reachable consumer reads them) — required, not defaulted,
 * so a new call site can't silently ship them unredacted. Always derive it
 * via `redactPersonalFor(req)` below rather than a literal, even at the two
 * `requireManager`-gated write routes where it's always `false` today — a
 * hardcoded literal at those sites would silently start leaking these fields
 * again if either route ever became STAFF-reachable.
 */
function toDto(
  u: {
    id: string;
    fullName: string;
    jobTitle: string | null;
    phone: string | null;
    preferredLanguage: string | null;
    hiredAt: Date | null;
    isActive: boolean;
    terminatedAt: Date | null;
    role: { id: string; name: string } | null;
    location: { name: string };
  },
  redactPersonal: boolean,
) {
  return {
    id: u.id,
    fullName: u.fullName,
    jobTitle: u.jobTitle,
    // roleId is what every shift-write endpoint keys off. Exposing it
    // here (the query already joins `role`) is what lets RotaBuilder
    // offer a role picker for a location whose current week has no
    // shifts yet — without it, a new week can't be built at all.
    roleId: u.role?.id ?? null,
    roleName: u.role?.name ?? null,
    phone: redactPersonal ? null : u.phone,
    preferredLanguage: redactPersonal ? null : u.preferredLanguage,
    hiredAt: redactPersonal || !u.hiredAt ? null : u.hiredAt.toISOString().slice(0, 10),
    isActive: u.isActive,
    // Employment status is deliberately the isActive + terminatedAt PAIR (no
    // parallel status enum, which would be a second source of truth). Both
    // halves must therefore be exposed, and PATCH keeps them in lockstep.
    terminatedAt: redactPersonal || !u.terminatedAt ? null : u.terminatedAt.toISOString().slice(0, 10),
    venueName: u.location.name,
  };
}

/**
 * GET /api/staff-directory/:locationId — list staff for a location.
 * Deliberately not filtered to `isActive: true` — employment status is now
 * a real, user-facing field, so a manager needs to see (and un-set) a
 * terminated staff member too, not have them silently vanish.
 */
staffDirectoryRouter.get('/:locationId', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const users = await prisma.user.findMany({
      where: { locationId },
      orderBy: { fullName: 'asc' },
      include: { role: true, location: { select: { name: true } } },
    });
    const redactPersonal = redactPersonalFor(req);
    return res.status(200).json({ staff: users.map((u) => toDto(u, redactPersonal)) });
  } catch (err) {
    console.error('[staffDirectory.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the staff directory.' });
  }
});

/**
 * POST /api/staff-directory — add a new staff member.
 * body: { fullName, jobTitle?, phone?, preferredLanguage?, hiredAt? }
 * locationId is derived from the manager's own session, never from the body.
 * `isActive` is left at its schema default (`true`) for new hires.
 */
staffDirectoryRouter.post('/', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const fullName = String(req.body?.fullName ?? '').trim();
    const jobTitle = req.body?.jobTitle ? String(req.body.jobTitle).trim() : null;
    const phone = req.body?.phone ? String(req.body.phone).trim() : null;
    const preferredLanguage = req.body?.preferredLanguage ? String(req.body.preferredLanguage).trim() : null;
    const hiredAtStr = req.body?.hiredAt ? String(req.body.hiredAt).trim() : null;
    if (!fullName) return res.status(400).json({ error: 'fullName is required.' });
    if (hiredAtStr && !/^\d{4}-\d{2}-\d{2}$/.test(hiredAtStr)) {
      return res.status(400).json({ error: 'hiredAt must be formatted as YYYY-MM-DD.' });
    }
    const hiredAt = hiredAtStr ? new Date(`${hiredAtStr}T00:00:00.000Z`) : null;

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { locationId, fullName, jobTitle, phone, preferredLanguage, hiredAt },
        include: { role: true, location: { select: { name: true } } },
      });
      await writeAuditLog(tx, {
        locationId: req.user!.locationId,
        actorId: req.user!.id,
        action: 'STAFF_CREATED',
        entityType: 'User',
        entityId: created.id,
        note: `Added ${created.fullName} to the staff directory`,
      });
      return created;
    });
    return res.status(201).json(toDto(user, redactPersonalFor(req)));
  } catch (err) {
    console.error('[staffDirectory.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while adding the staff member.' });
  }
});

/**
 * PATCH /api/staff-directory/:userId — edit an existing staff member.
 * Accepts fullName, jobTitle, phone, preferredLanguage, hiredAt, and
 * isActive (the employment-status toggle).
 */
staffDirectoryRouter.patch('/:userId', requireSession, requireManager, async (req, res) => {
  try {
    const { userId } = req.params;
    const data: {
      fullName?: string;
      jobTitle?: string | null;
      phone?: string | null;
      preferredLanguage?: string | null;
      hiredAt?: Date | null;
      isActive?: boolean;
      terminatedAt?: Date | null;
    } = {};
    if (req.body?.fullName !== undefined) {
      const fullName = String(req.body.fullName).trim();
      if (!fullName) return res.status(400).json({ error: 'fullName cannot be empty.' });
      data.fullName = fullName;
    }
    if (req.body?.jobTitle !== undefined) {
      const jobTitle = req.body.jobTitle === null ? null : String(req.body.jobTitle).trim();
      data.jobTitle = jobTitle || null;
    }
    if (req.body?.phone !== undefined) {
      const phone = req.body.phone === null ? null : String(req.body.phone).trim();
      data.phone = phone || null;
    }
    if (req.body?.preferredLanguage !== undefined) {
      const preferredLanguage = req.body.preferredLanguage === null ? null : String(req.body.preferredLanguage).trim();
      data.preferredLanguage = preferredLanguage || null;
    }
    if (req.body?.hiredAt !== undefined) {
      if (req.body.hiredAt === null) {
        data.hiredAt = null;
      } else {
        const hiredAtStr = String(req.body.hiredAt).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(hiredAtStr)) {
          return res.status(400).json({ error: 'hiredAt must be formatted as YYYY-MM-DD.' });
        }
        data.hiredAt = new Date(`${hiredAtStr}T00:00:00.000Z`);
      }
    }
    if (req.body?.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive must be a boolean.' });
      }
      data.isActive = req.body.isActive;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update — provide at least one field to change.' });
    }

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!ownedOrNotFound(req, res, existing, `Staff member "${userId}" not found.`)) return;

    // Employment status is the isActive + terminatedAt pair, so the toggle has
    // to move both — otherwise terminatedAt stays permanently null and the two
    // fields disagree about the same fact. Only a real transition writes it, so
    // re-sending isActive:false doesn't overwrite the original termination date.
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      data.terminatedAt = data.isActive ? null : new Date();
    }

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data,
        include: { role: true, location: { select: { name: true } } },
      });
      await writeAuditLog(tx, {
        locationId: req.user!.locationId,
        actorId: req.user!.id,
        action: 'STAFF_UPDATED',
        entityType: 'User',
        entityId: updated.id,
        note: `Updated ${updated.fullName}'s staff record`,
      });
      return updated;
    });
    return res.status(200).json(toDto(user, redactPersonalFor(req)));
  } catch (err) {
    console.error('[staffDirectory.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating the staff member.' });
  }
});
