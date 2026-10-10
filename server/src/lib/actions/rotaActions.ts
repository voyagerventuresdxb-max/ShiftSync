import { writeAuditLog } from '../auditLog.js';
import { prisma } from '../prisma.js';
import { applyWeekPatch, lockWeek, snapshotWeek } from './weekActions.js';
import { validateRanges, type TimeRange, type WeekPatchOp, type WeekPatchRefusal } from '../../../../shared/rotaWeek.js';

/**
 * One saved template slot. `start`/`end` are always present (pre-v2 readers and
 * templates use them); rota builder v2 entries may also carry the venue shift
 * type and the 1–2 ranges they were saved with, and the staff-visible note.
 */
export interface TemplateEntry {
  dayOffset: number;
  roleId: string;
  userId: string | null;
  start: string;
  end: string;
  /** Manager-only briefing line (Shift.managerNotes), as before v2. */
  note?: string;
  shiftTypeId?: string | null;
  ranges?: TimeRange[];
  /** The staff-visible shift note (≤ 80 characters). */
  shiftNote?: string | null;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates and normalises the entries of a template being saved (POST
 * /api/rota-templates). A v2 entry may omit `start`/`end` when it has
 * `ranges` (they are derived: first start, last end); a `shiftTypeId` must
 * name a live shift type of this venue. Roles and people are checked when the
 * template is applied, as before.
 */
export async function normalizeTemplateEntries(
  raw: unknown,
  locationId: string,
): Promise<{ ok: true; entries: TemplateEntry[] } | { ok: false; message: string }> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: 'entries must be a non-empty array.' };
  if (raw.length > 500) return { ok: false, message: 'A template holds at most 500 entries.' };
  const typeRanges = new Map(
    (await prisma.shiftType.findMany({ where: { locationId, archivedAt: null }, select: { id: true, ranges: true } })).map((t): [string, TimeRange[] | null] => [t.id, validateRanges(t.ranges) ? t.ranges : null]),
  );
  const entries: TemplateEntry[] = [];
  for (const [i, value] of raw.entries()) {
    const e = (value ?? {}) as Record<string, unknown>;
    const where = `Entry ${i + 1}`;
    const dayOffset = e.dayOffset;
    if (typeof dayOffset !== 'number' || !Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 6) return { ok: false, message: `${where}: dayOffset must be 0 (Monday) to 6 (Sunday).` };
    if (typeof e.roleId !== 'string' || !e.roleId) return { ok: false, message: `${where}: roleId is required.` };
    if (e.userId !== undefined && e.userId !== null && typeof e.userId !== 'string') return { ok: false, message: `${where}: userId must be a string or null.` };
    let ranges: TimeRange[] | undefined;
    if (e.ranges !== undefined && e.ranges !== null) {
      if (!validateRanges(e.ranges)) return { ok: false, message: `${where}: ranges must be 1–2 HH:MM ranges; only the last may cross midnight.` };
      ranges = e.ranges.map((r) => ({ start: r.start, end: r.end }));
    }
    let shiftTypeId: string | null = null;
    if (e.shiftTypeId !== undefined && e.shiftTypeId !== null) {
      if (typeof e.shiftTypeId !== 'string' || !typeRanges.has(e.shiftTypeId)) return { ok: false, message: `${where}: shift type not found or archived.` };
      shiftTypeId = e.shiftTypeId;
    }
    // start/end for pre-v2 readers: given, else the saved ranges', else the type's current times.
    const timing = ranges ?? (shiftTypeId ? typeRanges.get(shiftTypeId) : null) ?? null;
    const start = typeof e.start === 'string' ? e.start : timing ? timing[0]!.start : undefined;
    const end = typeof e.end === 'string' ? e.end : timing ? timing[timing.length - 1]!.end : undefined;
    if (!start || !end || !HHMM_RE.test(start) || !HHMM_RE.test(end)) return { ok: false, message: `${where}: start and end must be HH:MM (or give ranges or a shift type).` };
    if (e.note !== undefined && e.note !== null && typeof e.note !== 'string') return { ok: false, message: `${where}: note must be text.` };
    if (e.shiftNote !== undefined && e.shiftNote !== null && (typeof e.shiftNote !== 'string' || e.shiftNote.trim().length > 80)) {
      return { ok: false, message: `${where}: shiftNote must be text of at most 80 characters.` };
    }
    entries.push({
      dayOffset,
      roleId: e.roleId,
      userId: typeof e.userId === 'string' && e.userId ? e.userId : null,
      start,
      end,
      ...(typeof e.note === 'string' && e.note.trim() ? { note: e.note.trim().slice(0, 1000) } : {}),
      ...(shiftTypeId ? { shiftTypeId } : {}),
      ...(ranges ? { ranges } : {}),
      ...(typeof e.shiftNote === 'string' && e.shiftNote.trim() ? { shiftNote: e.shiftNote.trim() } : {}),
    });
  }
  return { ok: true, entries };
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
    // The week's lock first (snapshotWeek below takes it again, re-entrantly): no grid patch may land between
    // these writes and the snapshot, or the snapshot would record a draft nobody was told about.
    await lockWeek(tx, input.locationId, weekIso);
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
 * An entry's `note` stays the manager-only `managerNotes` it was before v2;
 * a v2 entry's `shiftNote` is the staff-visible note, `shiftTypeId`/`ranges`
 * its timing (see TemplateEntry). People who have left get open shifts.
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

  // People who have left (deactivated or deleted) since the template was saved: their slots are applied as
  // open shifts rather than refusing the whole template (design B5: "shifts become open").
  const departed = new Set<string>();
  if (userIds.length > 0) {
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, locationId: true, isActive: true, deletedAt: true } });
    const usersById = new Map(users.map((u) => [u.id, u]));
    for (const userId of userIds) {
      const user = usersById.get(userId);
      if (!user || user.locationId !== template.locationId) {
        return { result: 'invalid_user', userId, message: `Staff member "${userId}" not found.` };
      }
      if (!user.isActive || user.deletedAt) departed.add(userId);
    }
  }

  // POST /api/rota-templates already rejects an empty `entries` array, but a template written straight to
  // the database (or a stale one) must not bump the week's version or write audit rows for nothing.
  if (entries.length === 0) return { result: 'ok', createdCount: 0, templateName: template.name };

  // A v2 entry names its shift type; a type archived since the template was saved falls back to the saved times.
  const liveTypeIds = new Set(
    (await prisma.shiftType.findMany({ where: { locationId: template.locationId, archivedAt: null }, select: { id: true } })).map((t) => t.id),
  );
  const weekStart = input.weekStart.toISOString().slice(0, 10);
  const ops = entries.map((e): WeekPatchOp => {
    const date = new Date(input.weekStart);
    date.setUTCDate(date.getUTCDate() + e.dayOffset);
    const userId = e.userId && !departed.has(String(e.userId)) ? String(e.userId) : null;
    const savedRanges = validateRanges(e.ranges) ? e.ranges : null;
    const typeId = typeof e.shiftTypeId === 'string' && liveTypeIds.has(e.shiftTypeId) ? e.shiftTypeId : null;
    return {
      op: 'create',
      userId,
      roleId: String(e.roleId),
      date: date.toISOString().slice(0, 10),
      // A live type without saved ranges takes the type's current times; otherwise the saved times, labelled with
      // the type when it still exists.
      ...(typeId ? { shiftTypeId: typeId } : {}),
      ...(typeId && !savedRanges ? {} : { ranges: savedRanges ?? [{ start: e.start, end: e.end }] }),
      note: typeof e.shiftNote === 'string' && e.shiftNote.trim() ? e.shiftNote.trim().slice(0, 80) : null,
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
  // An entry's `note` is the manager-only briefing line it always was (Shift.managerNotes, outside the week
  // document), written onto the new rows straight after the patch.
  for (const [i, e] of entries.entries()) {
    const shiftId = result.results[i]?.shiftId;
    if (shiftId && typeof e.note === 'string' && e.note.trim()) await prisma.shift.update({ where: { id: shiftId }, data: { managerNotes: e.note.trim() } });
  }
  return { result: 'ok', createdCount: result.results.length, templateName: template.name };
}
