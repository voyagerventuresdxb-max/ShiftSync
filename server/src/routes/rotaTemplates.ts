import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from '../parsing/normalize.js';
import { requireSession, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { withAuditedTransaction } from '../lib/auditLog.js';

export const rotaTemplatesRouter = Router();

interface TemplateEntry {
  dayOffset: number;
  roleId: string;
  userId: string | null;
  start: string;
  end: string;
  note?: string;
}

/**
 * GET /api/rota-templates/:locationId
 * Session-gated (2026-08-31 — see MEMORY.md): no comment on record ever
 * justified this staying anonymous, and its only real consumer
 * (`RotaBuilder.tsx`) has lived inside the session-gated `/schedule` route
 * since the kiosk-access-fork phase — this reads as an overlooked gap, not
 * a deliberate one, found by the anonymous-read sweep.
 */
rotaTemplatesRouter.get('/:locationId', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
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

/**
 * POST /api/rota-templates — body: { name, entries, createdById? }
 * Session-gated; `locationId` comes from the session, not the body.
 * `createdById` is only honored for a MANAGER/OWNER session — same
 * on-behalf-of rule as shifts.ts's POST /.
 */
rotaTemplatesRouter.post('/', requireSession, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const name = String(req.body?.name ?? '').trim();
    const entries = Array.isArray(req.body?.entries) ? (req.body.entries as TemplateEntry[]) : [];
    const createdById =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.createdById ? String(req.body.createdById).trim() : '') || req.user!.id;

    if (createdById !== req.user!.id) {
      const onBehalfUser = await prisma.user.findUnique({ where: { id: createdById } });
      if (!ownedOrNotFound(req, res, onBehalfUser, `Staff member "${createdById}" not found.`)) return;
    }

    if (!name) return res.status(400).json({ error: 'name is required.' });
    if (entries.length === 0) return res.status(400).json({ error: 'entries must be a non-empty array.' });

    const created = await withAuditedTransaction(
      prisma,
      (tx) =>
        tx.rotaTemplate.create({
          data: { locationId, name, entries: entries as unknown as Prisma.InputJsonValue, createdById },
        }),
      (template) => ({
        locationId,
        actorId: req.user!.id,
        action: 'ROTA_TEMPLATE_CREATED',
        entityType: 'RotaTemplate',
        entityId: template.id,
        note: `Created template "${name}" (${entries.length} entries)`,
      }),
    );
    return res.status(201).json({
      template: { id: created.id, name: created.name, entryCount: entries.length, createdAt: created.createdAt.toISOString() },
    });
  } catch (err) {
    console.error('[rotaTemplates.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the template.' });
  }
});

/** DELETE /api/rota-templates/:id — session-gated, own venue only. */
rotaTemplatesRouter.delete('/:id', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.rotaTemplate.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Template "${id}" not found.`)) return;
    await withAuditedTransaction(
      prisma,
      (tx) => tx.rotaTemplate.delete({ where: { id } }),
      () => ({
        locationId: existing.locationId,
        actorId: req.user!.id,
        action: 'ROTA_TEMPLATE_DELETED',
        entityType: 'RotaTemplate',
        entityId: id,
        note: `Deleted template "${existing.name}"`,
      }),
    );
    return res.status(204).send();
  } catch (err) {
    console.error('[rotaTemplates.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the template.' });
  }
});

/** POST /api/rota-templates/:id/apply — body: { weekStart, createdById? } — creates real Shift rows for the target week. */
rotaTemplatesRouter.post('/:id/apply', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    const weekStart = String(req.body?.weekStart ?? '').trim();
    const createdById =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.createdById ? String(req.body.createdById).trim() : '') || req.user!.id;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart is required, as YYYY-MM-DD.' });

    if (createdById !== req.user!.id) {
      const onBehalfUser = await prisma.user.findUnique({ where: { id: createdById } });
      if (!ownedOrNotFound(req, res, onBehalfUser, `Staff member "${createdById}" not found.`)) return;
    }

    const template = await prisma.rotaTemplate.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, template, `Template "${id}" not found.`)) return;

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

    const created = await withAuditedTransaction(
      prisma,
      async (tx) => {
        // Sequential, not Promise.all: `tx` is bound to a single reserved DB
        // connection, so concurrent creates against it wouldn't parallelize
        // anyway and risk tripping the transaction's own timeout.
        const rows: { id: string }[] = [];
        for (const e of entries) {
          const date = new Date(start);
          date.setUTCDate(date.getUTCDate() + e.dayOffset);
          const dateStr = date.toISOString().slice(0, 10);
          const overnight = e.end <= e.start;
          rows.push(
            await tx.shift.create({
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
            }),
          );
        }
        return rows;
      },
      (rows) => ({
        locationId: template.locationId,
        actorId: req.user!.id,
        action: 'SHIFT_CREATED',
        entityType: 'Shift',
        entityId: rows[0]?.id ?? id,
        note: `Applied template "${template.name}" to week ${weekStart} — created ${rows.length} shift(s)`,
      }),
    );
    return res.status(201).json({ createdCount: created.length });
  } catch (err) {
    console.error('[rotaTemplates.apply] failed', err);
    return res.status(500).json({ error: 'Unexpected error while applying the template.' });
  }
});
