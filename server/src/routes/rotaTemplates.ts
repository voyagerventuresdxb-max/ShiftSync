import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from '../parsing/normalize.js';

export const rotaTemplatesRouter = Router();

interface TemplateEntry {
  dayOffset: number;
  roleId: string;
  userId: string | null;
  start: string;
  end: string;
  note?: string;
}

/** GET /api/rota-templates/:locationId */
rotaTemplatesRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const templates = await prisma.rotaTemplate.findMany({ where: { locationId }, orderBy: { createdAt: 'desc' } });
    return res.status(200).json({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        entryCount: (t.entries as unknown as TemplateEntry[]).length,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[rotaTemplates.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading templates.' });
  }
});

/** POST /api/rota-templates — body: { locationId, name, entries, createdById? } */
rotaTemplatesRouter.post('/', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    const entries = Array.isArray(req.body?.entries) ? (req.body.entries as TemplateEntry[]) : [];
    const createdById = req.body?.createdById ? String(req.body.createdById).trim() : null;

    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!name) return res.status(400).json({ error: 'name is required.' });
    if (entries.length === 0) return res.status(400).json({ error: 'entries must be a non-empty array.' });

    const created = await prisma.rotaTemplate.create({
      data: { locationId, name, entries: entries as unknown as Prisma.InputJsonValue, createdById },
    });
    return res.status(201).json({
      template: { id: created.id, name: created.name, entryCount: entries.length, createdAt: created.createdAt.toISOString() },
    });
  } catch (err) {
    console.error('[rotaTemplates.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the template.' });
  }
});

/** DELETE /api/rota-templates/:id */
rotaTemplatesRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.rotaTemplate.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Template "${id}" not found.` });
    await prisma.rotaTemplate.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    console.error('[rotaTemplates.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the template.' });
  }
});

/** POST /api/rota-templates/:id/apply — body: { weekStart, createdById? } — creates real Shift rows for the target week. */
rotaTemplatesRouter.post('/:id/apply', async (req, res) => {
  try {
    const { id } = req.params;
    const weekStart = String(req.body?.weekStart ?? '').trim();
    const createdById = req.body?.createdById ? String(req.body.createdById).trim() : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart is required, as YYYY-MM-DD.' });

    const template = await prisma.rotaTemplate.findUnique({ where: { id } });
    if (!template) return res.status(404).json({ error: `Template "${id}" not found.` });

    const entries = template.entries as unknown as TemplateEntry[];

    // Validate every entry's roleId (and userId, if set) exists and belongs
    // to the template's own locationId before creating anything — same
    // existence + same-location checks POST /api/shifts and /api/shifts/bulk
    // apply, so a stale/foreign id rejects the whole apply with a clean 404
    // instead of a raw FK-violation 500 thrown mid-transaction after some
    // shifts may already have committed.
    const roleIds = [...new Set(entries.map((e) => String(e.roleId)))];
    const userIds = [...new Set(entries.map((e) => (e.userId ? String(e.userId) : null)).filter((v): v is string => v !== null))];

    const roles = await prisma.role.findMany({ where: { id: { in: roleIds } } });
    const rolesById = new Map(roles.map((r) => [r.id, r]));
    for (const roleId of roleIds) {
      const role = rolesById.get(roleId);
      if (!role || role.locationId !== template.locationId) return res.status(404).json({ error: `Role "${roleId}" not found.` });
    }

    if (userIds.length > 0) {
      const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
      const usersById = new Map(users.map((u) => [u.id, u]));
      for (const userId of userIds) {
        const user = usersById.get(userId);
        if (!user || user.locationId !== template.locationId) return res.status(404).json({ error: `Staff member "${userId}" not found.` });
      }
    }

    const location = await prisma.location.findUnique({ where: { id: template.locationId }, select: { timezone: true } });
    const timezone = location?.timezone || DEFAULT_VENUE_TIMEZONE;
    const start = new Date(`${weekStart}T00:00:00.000Z`);

    const created = await prisma.$transaction(
      entries.map((e) => {
        const date = new Date(start);
        date.setUTCDate(date.getUTCDate() + e.dayOffset);
        const dateStr = date.toISOString().slice(0, 10);
        const overnight = e.end <= e.start;
        return prisma.shift.create({
          data: {
            locationId: template.locationId,
            roleId: e.roleId,
            userId: e.userId,
            createdById,
            date,
            startTime: combineDateAndTime(dateStr, e.start, timezone),
            endTime: combineDateAndTime(dateStr, e.end, timezone, overnight),
            managerNotes: e.note ?? null,
            status: 'DRAFT',
          },
        });
      }),
    );
    return res.status(201).json({ createdCount: created.length });
  } catch (err) {
    console.error('[rotaTemplates.apply] failed', err);
    return res.status(500).json({ error: 'Unexpected error while applying the template.' });
  }
});
