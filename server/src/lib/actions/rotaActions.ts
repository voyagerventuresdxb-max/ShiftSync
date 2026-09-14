import { prisma } from '../prisma.js';
import { withAuditedTransaction } from '../auditLog.js';
import { combineDateAndTime, DEFAULT_VENUE_TIMEZONE } from '../../parsing/normalize.js';

interface TemplateEntry {
  dayOffset: number;
  roleId: string;
  userId: string | null;
  start: string;
  end: string;
  note?: string;
}

/**
 * Exactly the `groupBy` `routes/shifts.ts`'s `POST /:locationId/publish` made
 * inline before this extraction — one round-trip that returns both the total
 * shift count and the distinct-assigned-staff count without pulling a full
 * row per shift. Also used by `routes/voice.ts`'s `/parse-intent` to compute
 * PUBLISH_ROTA's confirm-preview count once the model has resolved a
 * `weekStart` — never trust the model's own arithmetic for this number (see
 * spec §2.1: the whole point of this function existing here, not just inside
 * `publishRota`, is that the preview and the actual publish read the exact
 * same query).
 */
export async function getRotaPublishPreview(
  locationId: string,
  weekStart: Date,
): Promise<{ shiftCount: number; staffCount: number }> {
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const shiftGroups = await prisma.shift.groupBy({
    by: ['userId'],
    where: { locationId, date: { gte: weekStart, lt: weekEnd } },
    _count: true,
  });
  const shiftCount = shiftGroups.reduce((sum, g) => sum + g._count, 0);
  const staffCount = shiftGroups.filter((g) => g.userId !== null).length;
  return { shiftCount, staffCount };
}

export type PublishRotaResult =
  | { result: 'ok'; publishedAt: Date; notifiedCount: number; affectedUserIds: string[] }
  | { result: 'not_found'; message: string }
  | { result: 'empty'; message: string };

/**
 * Raw publish — exactly the `prisma.$transaction([...])` call
 * `routes/shifts.ts`'s `POST /:locationId/publish` made inline before this
 * extraction. Existence (location) and non-emptiness (the target week must
 * have at least one shift) checks live HERE, inside the action, rather than
 * split across callers — unlike `sectionActions.ts`/`swapActions.ts`'s
 * validate-in-caller precedent, this slice's mutators own their own
 * validation so `routes/rotaTemplates.ts`/`routes/shifts.ts` and
 * `routes/voice.ts`'s `/execute` never duplicate the same checks (spec §2.3).
 * No `withAuditedTransaction`/audit-log row today — matches the pre-
 * extraction route, which never wrote one for a publish either.
 */
export async function publishRota(input: {
  locationId: string;
  weekStart: Date;
  publishedById: string;
}): Promise<PublishRotaResult> {
  const location = await prisma.location.findUnique({ where: { id: input.locationId } });
  if (!location) return { result: 'not_found', message: `Location "${input.locationId}" not found.` };

  const weekEnd = new Date(input.weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const shiftGroups = await prisma.shift.groupBy({
    by: ['userId'],
    where: { locationId: input.locationId, date: { gte: input.weekStart, lt: weekEnd } },
    _count: true,
  });
  const shiftCount = shiftGroups.reduce((sum, g) => sum + g._count, 0);
  if (shiftCount === 0) return { result: 'empty', message: 'No shifts exist for this week yet.' };

  const notifiedCount = shiftGroups.filter((g) => g.userId !== null).length;
  // Capture one shared instant for both writes — see routes/shifts.ts's
  // original comment: without this, RotaPublish's `publishedAt` and Shift's
  // auto `@updatedAt` never line up, and every shift looks "changed since
  // publish" the instant it was published.
  const publishedAt = new Date();
  const [publish] = await prisma.$transaction([
    prisma.rotaPublish.upsert({
      where: { locationId_weekStart: { locationId: input.locationId, weekStart: input.weekStart } },
      create: { locationId: input.locationId, weekStart: input.weekStart, publishedAt, publishedById: input.publishedById, notifiedCount },
      update: { publishedAt, publishedById: input.publishedById, notifiedCount },
    }),
    prisma.shift.updateMany({
      where: { locationId: input.locationId, date: { gte: input.weekStart, lt: weekEnd } },
      data: { status: 'PUBLISHED', updatedAt: publishedAt },
    }),
  ]);

  const affectedUserIds = shiftGroups
    .filter((g): g is typeof g & { userId: string } => g.userId !== null)
    .map((g) => g.userId);

  return { result: 'ok', publishedAt: publish.publishedAt, notifiedCount: publish.notifiedCount, affectedUserIds };
}

export type ApplyRotaTemplateResult =
  | { result: 'ok'; createdCount: number; templateName: string }
  | { result: 'template_not_found'; message: string }
  | { result: 'invalid_role'; roleId: string; message: string }
  | { result: 'invalid_user'; userId: string; message: string };

/**
 * Raw apply — exactly the `withAuditedTransaction(...)` call
 * `routes/rotaTemplates.ts`'s `POST /:id/apply` made inline before this
 * extraction, including the per-entry role/user existence + same-location
 * validation, moved IN from the caller for the same no-duplicate-validation
 * reason as `publishRota` above (spec §2.3).
 */
export async function applyRotaTemplate(input: {
  templateId: string;
  weekStart: Date;
  createdById: string;
  /** Audit-log actor — may differ from createdById the same way the on-behalf-of REST path allows today. */
  actorId: string;
}): Promise<ApplyRotaTemplateResult> {
  const template = await prisma.rotaTemplate.findUnique({ where: { id: input.templateId } });
  if (!template) return { result: 'template_not_found', message: `Template "${input.templateId}" not found.` };

  const entries = template.entries as unknown as TemplateEntry[];
  const roleIds = [...new Set(entries.map((e) => String(e.roleId)))];
  const userIds = [...new Set(entries.map((e) => (e.userId ? String(e.userId) : null)).filter((v): v is string => v !== null))];

  const roles = await prisma.role.findMany({ where: { id: { in: roleIds } } });
  const rolesById = new Map(roles.map((r) => [r.id, r]));
  for (const roleId of roleIds) {
    const role = rolesById.get(roleId);
    if (!role || role.locationId !== template.locationId) {
      return { result: 'invalid_role', roleId, message: `Role "${roleId}" not found.` };
    }
  }

  if (userIds.length > 0) {
    const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
    const usersById = new Map(users.map((u) => [u.id, u]));
    for (const userId of userIds) {
      const user = usersById.get(userId);
      if (!user || user.locationId !== template.locationId) {
        return { result: 'invalid_user', userId, message: `Staff member "${userId}" not found.` };
      }
    }
  }

  const location = await prisma.location.findUnique({ where: { id: template.locationId }, select: { timezone: true } });
  const timezone = location?.timezone || DEFAULT_VENUE_TIMEZONE;

  const created = await withAuditedTransaction(
    prisma,
    async (tx) => {
      // Sequential, not Promise.all: `tx` is bound to a single reserved DB
      // connection (see routes/rotaTemplates.ts's original comment).
      const rows: { id: string }[] = [];
      for (const e of entries) {
        const date = new Date(input.weekStart);
        date.setUTCDate(date.getUTCDate() + e.dayOffset);
        const dateStr = date.toISOString().slice(0, 10);
        const overnight = e.end <= e.start;
        rows.push(
          await tx.shift.create({
            data: {
              locationId: template.locationId,
              roleId: e.roleId,
              userId: e.userId,
              createdById: input.createdById,
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
    // Currently unreachable — POST /api/rota-templates already rejects an
    // empty `entries` array at creation time, so `entries`/`rows` here can
    // never legitimately be empty — but guarded anyway, matching the
    // identical `count > 0 ? {...} : null` convention schedules.ts's confirm
    // route and floorPlan.ts's publish route already use for this exact
    // shape of no-op, so a future second write path into this action (or a
    // stale/corrupted template) can't silently write a false SHIFT_CREATED
    // audit row claiming shifts were created when none were.
    (rows) =>
      rows.length > 0
        ? {
            locationId: template.locationId,
            actorId: input.actorId,
            action: 'SHIFT_CREATED',
            entityType: 'Shift',
            entityId: rows[0].id,
            note: `Applied template "${template.name}" to week ${input.weekStart.toISOString().slice(0, 10)} — created ${rows.length} shift(s)`,
          }
        : null,
  );
  return { result: 'ok', createdCount: created.length, templateName: template.name };
}
