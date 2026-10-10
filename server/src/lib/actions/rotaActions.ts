import { writeAuditLog } from '../auditLog.js';
import { prisma } from '../prisma.js';
import { applyWeekPatch, snapshotWeek } from './weekActions.js';
import type { WeekPatchOp, WeekPatchRefusal } from '../../../../shared/rotaWeek.js';

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
): Promise<{ shiftCount: number; staffCount: number; shiftsChanging: number }> {
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const shiftGroups = await prisma.shift.groupBy({
    by: ['userId'],
    where: { locationId, date: { gte: weekStart, lt: weekEnd }, status: { not: 'CANCELLED' } },
    _count: true,
  });
  const shiftCount = shiftGroups.reduce((sum, g) => sum + g._count, 0);
  // `publishRota` notifies everyone with a shift that week, so that is who gets notified.
  const staffCount = shiftGroups.filter((g) => g.userId !== null).length;
  // What this publish actually changes: shifts not yet published, or edited since the week's last
  // publish (the same comparison GET /api/shifts/:locationId/publish-status makes).
  const last = await prisma.rotaPublish.findUnique({ where: { locationId_weekStart: { locationId, weekStart } }, select: { publishedAt: true } });
  const shiftsChanging = await prisma.shift.count({
    where: {
      locationId,
      date: { gte: weekStart, lt: weekEnd },
      OR: [{ status: { not: 'PUBLISHED' } }, ...(last ? [{ updatedAt: { gt: last.publishedAt } }] : [])],
    },
  });
  return { shiftCount, staffCount, shiftsChanging };
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
    where: { locationId: input.locationId, date: { gte: input.weekStart, lt: weekEnd }, status: { not: 'CANCELLED' } },
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
  const weekIso = input.weekStart.toISOString().slice(0, 10);
  const publish = await prisma.$transaction(async (tx) => {
    const row = await tx.rotaPublish.upsert({
      where: { locationId_weekStart: { locationId: input.locationId, weekStart: input.weekStart } },
      create: { locationId: input.locationId, weekStart: input.weekStart, publishedAt, publishedById: input.publishedById, notifiedCount },
      update: { publishedAt, publishedById: input.publishedById, notifiedCount },
    });
    const inWeek = { locationId: input.locationId, date: { gte: input.weekStart, lt: weekEnd } };
    // Rota builder v2: a CANCELLED row is a published shift the manager removed, waiting for a publish to
    // tell the person — never resurrected here; it goes once the new snapshot (below) no longer lists it.
    await tx.shift.deleteMany({ where: { ...inWeek, status: 'CANCELLED' } });
    await tx.shift.updateMany({
      where: inWeek,
      data: { status: 'PUBLISHED', updatedAt: publishedAt, editedSincePublish: false },
    });
    await tx.shift.updateMany({ where: { ...inWeek, publishedAt: null }, data: { publishedAt } });
    await tx.rotaLeave.updateMany({ where: { ...inWeek, status: 'DRAFT' }, data: { status: 'PUBLISHED', updatedAt: publishedAt } });
    // Keep the v2 week row in step (version, state, snapshot), so the new grid's diff and "unpublished
    // changes" dot agree with what this legacy publish just told staff.
    await snapshotWeek(tx, input.locationId, weekIso, { publishedById: input.publishedById, publishedAt });
    // The publish is a venue-wide event staff act on; it gets its own audit
    // row (REST and voice both land here), committed with the publish itself.
    await writeAuditLog(tx, {
      locationId: input.locationId,
      actorId: input.publishedById,
      action: 'ROTA_PUBLISHED',
      entityType: 'RotaPublish',
      entityId: row.id,
      note: `Published the rota for the week of ${weekIso}: ${shiftCount} shift(s), ${notifiedCount} people notified.`,
    });
    return row;
  });

  const affectedUserIds = shiftGroups
    .filter((g): g is typeof g & { userId: string } => g.userId !== null)
    .map((g) => g.userId);

  return { result: 'ok', publishedAt: publish.publishedAt, notifiedCount: publish.notifiedCount, affectedUserIds };
}

export type ApplyRotaTemplateResult =
  | { result: 'ok'; createdCount: number; templateName: string }
  | { result: 'template_not_found'; message: string }
  | { result: 'invalid_role'; roleId: string; message: string }
  | { result: 'invalid_user'; userId: string; message: string }
  /** The week patch refused an entry (a person already on that day, on leave, a past day…) or the week moved. */
  | { result: 'refused'; refusal: WeekPatchRefusal | 'version_conflict'; message: string };

/**
 * Applies a template as ONE week patch (source 'template', lib/actions/
 * weekActions.ts): every entry becomes a `create` op, so the week's version
 * bumps once, the one-shift-per-person-day and leave rules hold, and a
 * refused entry rolls the whole apply back — a half-applied template is
 * worse than none. The per-entry role/user existence + same-location checks
 * stay here so the result kinds this action's callers (routes/rotaTemplates.ts,
 * routes/voice.ts) already map keep their meaning.
 *
 * A template entry's `note` was the manager-only `managerNotes` before v2; the
 * week patch has only the staff-visible `note` (≤ 80 chars), so it lands there.
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

  // POST /api/rota-templates already rejects an empty `entries` array, but a template written straight to
  // the database (or a stale one) must not bump the week's version or write audit rows for nothing.
  if (entries.length === 0) return { result: 'ok', createdCount: 0, templateName: template.name };

  const weekStart = input.weekStart.toISOString().slice(0, 10);
  const ops = entries.map((e): WeekPatchOp => {
    const date = new Date(input.weekStart);
    date.setUTCDate(date.getUTCDate() + e.dayOffset);
    return {
      op: 'create',
      userId: e.userId ? String(e.userId) : null,
      roleId: String(e.roleId),
      date: date.toISOString().slice(0, 10),
      ranges: [{ start: e.start, end: e.end }],
      note: e.note ? e.note.slice(0, 80) : null,
    };
  });
  // `createdById` is the recorded actor (Shift.createdById and the audit rows) when it differs from
  // actorId only in the on-behalf-of case, which the audit note names.
  const result = await applyWeekPatch({
    locationId: template.locationId,
    weekStart,
    actorId: input.createdById,
    source: 'template',
    patch: {
      ops,
      note: `Applied template "${template.name}"${input.actorId !== input.createdById ? ` (by ${input.actorId} on behalf of ${input.createdById})` : ''}`,
    },
  });
  if (result.result === 'version_conflict') return { result: 'refused', refusal: 'version_conflict', message: 'The week changed while the template was being applied — try again.' };
  if (result.result === 'refused') return { result: 'refused', refusal: result.refusal, message: `Entry ${result.op + 1}: ${result.message}` };
  return { result: 'ok', createdCount: result.results.length, templateName: template.name };
}
