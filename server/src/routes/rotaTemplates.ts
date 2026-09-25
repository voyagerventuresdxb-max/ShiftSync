import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { withAuditedTransaction } from '../lib/auditLog.js';
import { applyRotaTemplate } from '../lib/actions/rotaActions.js';

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
 * `requireManager`-gated (2026-09-05 — see MEMORY.md; a real, pre-existing
 * gap the `withAuditedTransaction` review found: this route, `DELETE /:id`,
 * and `POST /:id/apply` below were all `requireSession`-only, so any
 * authenticated STAFF session could create/delete templates or apply one to
 * bulk-create a full week of real shifts — the same class of gap
 * `shifts.ts`'s own `requireManager` fix closed earlier). `locationId` comes
 * from the session, not the body, and so does `createdById` (a body value
 * is ignored since 2026-09-25, matching `shifts.ts`).
 */
rotaTemplatesRouter.post('/', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const name = String(req.body?.name ?? '').trim();
    const entries = Array.isArray(req.body?.entries) ? (req.body.entries as TemplateEntry[]) : [];
    // Always the signed-in manager — a body-supplied createdById is ignored
    // (2026-09-25, same rule as routes/shifts.ts): it let the audit trail and
    // the created rows name someone other than whoever actually did this.
    const createdById = req.user!.id;

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

/** DELETE /api/rota-templates/:id — `requireManager`-gated (2026-09-05, same fix as POST /, above), own venue only. */
rotaTemplatesRouter.delete('/:id', requireSession, requireManager, async (req, res) => {
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

/**
 * POST /api/rota-templates/:id/apply — body: { weekStart, createdById? } —
 * bulk-creates real Shift rows for the target week. `requireManager`-gated
 * (2026-09-05, same fix as POST /, above) — this was the most severe of the
 * three gaps found: a STAFF session could otherwise bulk-create a full
 * week of shifts for the whole venue with one call, no UI needed.
 */
rotaTemplatesRouter.post('/:id/apply', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const weekStart = String(req.body?.weekStart ?? '').trim();
    // Always the signed-in manager — a body-supplied createdById is ignored
    // (2026-09-25, same rule as routes/shifts.ts): it let the audit trail and
    // the created rows name someone other than whoever actually did this.
    const createdById = req.user!.id;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'weekStart is required, as YYYY-MM-DD.' });

    // Ownership check stays here (the route knows the caller's own venue via
    // the session; the extracted action doesn't take a callerLocationId to
    // scope against) — applyRotaTemplate itself still separately confirms
    // the template exists at all.
    const templateForOwnershipCheck = await prisma.rotaTemplate.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, templateForOwnershipCheck, `Template "${id}" not found.`)) return;

    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const result = await applyRotaTemplate({ templateId: id, weekStart: start, createdById, actorId: req.user!.id });
    if (result.result !== 'ok') {
      return res.status(result.result === 'blocked_by_leave' ? 409 : 404).json({ error: result.message });
    }
    return res.status(201).json({ createdCount: result.createdCount });
  } catch (err) {
    console.error('[rotaTemplates.apply] failed', err);
    return res.status(500).json({ error: 'Unexpected error while applying the template.' });
  }
});
