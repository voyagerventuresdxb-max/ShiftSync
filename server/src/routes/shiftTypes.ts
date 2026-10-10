import { Router } from 'express';
import type { Prisma, ShiftType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';
import { withAuditedTransaction, writeAuditLog } from '../lib/auditLog.js';
import { rangesEndNextDay, SHIFT_TINTS, validateRanges, type ShiftTint, type ShiftTypeDto, type ShiftTypeInput, type TimeRange } from '../../../shared/rotaWeek.js';

/**
 * Rota builder v2 — a venue's shift types (Morning, Mid, Evening, Split…), the
 * timings the manager drags onto the week grid (shared/rotaWeek.ts:
 * ShiftTypeInput, ShiftTypePatch). Any session of the venue may read them;
 * every write is manager-only and audited. Editing a type's times never
 * rewrites existing shifts: each shift froze its own ranges when it was made,
 * so published history stays what staff were told.
 */
export const shiftTypesRouter = Router();

const NAME_MAX = 40;

export function shiftTypeToDto(t: ShiftType): ShiftTypeDto {
  const ranges = validateRanges(t.ranges) ? t.ranges.map((r) => ({ start: r.start, end: r.end })) : [];
  const tint = (SHIFT_TINTS as readonly string[]).includes(t.tint) ? (t.tint as ShiftTint) : 'cream';
  return { id: t.id, name: t.name, ranges, endsNextDay: t.endsNextDay, tint, sortOrder: t.sortOrder, archivedAt: t.archivedAt?.toISOString() ?? null };
}

/** Live types first (by sortOrder, then name), archived after — the same order the week document uses. */
async function venueShiftTypes(locationId: string): Promise<ShiftTypeDto[]> {
  const rows = await prisma.shiftType.findMany({ where: { locationId } });
  return rows
    .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(shiftTypeToDto);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Checks a full (create) or partial (patch) ShiftTypeInput; returns only the fields that were sent. */
function parseShiftTypeInput(body: unknown, partial: boolean): Parsed<Partial<ShiftTypeInput>> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<ShiftTypeInput> = {};
  if (b.name !== undefined || !partial) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { ok: false, message: 'name is required.' };
    if (b.name.trim().length > NAME_MAX) return { ok: false, message: `name is at most ${NAME_MAX} characters.` };
    out.name = b.name.trim();
  }
  if (b.ranges !== undefined || !partial) {
    if (!validateRanges(b.ranges)) return { ok: false, message: 'ranges must be 1–2 HH:MM ranges; only the last may cross midnight, and the two must not overlap.' };
    out.ranges = b.ranges.map((r): TimeRange => ({ start: r.start, end: r.end }));
  }
  if (b.tint !== undefined || !partial) {
    if (typeof b.tint !== 'string' || !(SHIFT_TINTS as readonly string[]).includes(b.tint)) return { ok: false, message: `tint must be one of ${SHIFT_TINTS.join(', ')}.` };
    out.tint = b.tint as ShiftTint;
  }
  if (b.sortOrder !== undefined) {
    if (typeof b.sortOrder !== 'number' || !Number.isInteger(b.sortOrder) || b.sortOrder < 0 || b.sortOrder > 999) return { ok: false, message: 'sortOrder must be a whole number from 0 to 999.' };
    out.sortOrder = b.sortOrder;
  }
  return { ok: true, value: out };
}

const describe = (t: { name: string; ranges: TimeRange[] }) => `${t.name} ${t.ranges.map((r) => `${r.start}–${r.end}`).join(' + ')}`;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** GET /api/shift-types/:locationId → { shiftTypes }. Any session of the venue. */
shiftTypesRouter.get('/:locationId', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    return res.status(200).json({ shiftTypes: await venueShiftTypes(locationId) });
  } catch (err) {
    console.error('[shiftTypes.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading shift types.' });
  }
});

/** POST /api/shift-types/:locationId — body: ShiftTypeInput → 201 { shiftType }. 409 when the venue already has that name. */
shiftTypesRouter.post('/:locationId', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const parsed = parseShiftTypeInput(req.body, false);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message });
    const input = parsed.value as ShiftTypeInput;
    const existing = await prisma.shiftType.findMany({ where: { locationId }, select: { name: true, sortOrder: true } });
    if (existing.some((t) => sameName(t.name, input.name))) return res.status(409).json({ error: `There is already a shift type called "${input.name}".`, errorCode: 'shift_type_name_taken' });
    const created = await withAuditedTransaction(
      prisma,
      (tx) =>
        tx.shiftType.create({
          data: {
            locationId,
            name: input.name,
            ranges: input.ranges as unknown as Prisma.InputJsonValue,
            endsNextDay: rangesEndNextDay(input.ranges),
            tint: input.tint,
            sortOrder: input.sortOrder ?? existing.reduce((max, t) => Math.max(max, t.sortOrder + 1), 0),
          },
        }),
      (t) => ({ locationId, actorId: req.user!.id, action: 'SHIFT_TYPE_CREATED', entityType: 'ShiftType', entityId: t.id, note: `Created shift type ${describe(input)}` }),
    );
    return res.status(201).json({ shiftType: shiftTypeToDto(created) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'There is already a shift type with that name.', errorCode: 'shift_type_name_taken' });
    console.error('[shiftTypes.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the shift type.' });
  }
});

/**
 * POST /api/shift-types/:locationId/bulk — body: { shiftTypes: ShiftTypeInput[] } → { shiftTypes, skipped }.
 * Accepts the roster import's proposals in one go: every entry is checked first (one bad entry → 400, nothing
 * saved); a name the venue already has (or that repeats within the batch) is skipped, not duplicated.
 * `shiftTypes` is the venue's full list afterwards; `skipped` names what was not created.
 */
shiftTypesRouter.post('/:locationId/bulk', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const raw = req.body?.shiftTypes;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: 'shiftTypes must be a non-empty array.' });
    if (raw.length > 20) return res.status(400).json({ error: 'At most 20 shift types at once.' });
    const inputs: ShiftTypeInput[] = [];
    for (const [i, item] of raw.entries()) {
      const parsed = parseShiftTypeInput(item, false);
      if (!parsed.ok) return res.status(400).json({ error: `Shift type ${i + 1}: ${parsed.message}` });
      inputs.push(parsed.value as ShiftTypeInput);
    }
    const skipped: string[] = [];
    await prisma.$transaction(async (tx) => {
      const existing = await tx.shiftType.findMany({ where: { locationId }, select: { name: true, sortOrder: true } });
      const taken = existing.map((t) => t.name);
      let nextOrder = existing.reduce((max, t) => Math.max(max, t.sortOrder + 1), 0);
      for (const input of inputs) {
        if (taken.some((name) => sameName(name, input.name))) {
          skipped.push(input.name);
          continue;
        }
        const created = await tx.shiftType.create({
          data: {
            locationId,
            name: input.name,
            ranges: input.ranges as unknown as Prisma.InputJsonValue,
            endsNextDay: rangesEndNextDay(input.ranges),
            tint: input.tint,
            sortOrder: input.sortOrder ?? nextOrder++,
          },
        });
        taken.push(created.name);
        await writeAuditLog(tx, { locationId, actorId: req.user!.id, action: 'SHIFT_TYPE_CREATED', entityType: 'ShiftType', entityId: created.id, note: `Created shift type ${describe(input)} (from a roster import)` });
      }
    });
    return res.status(200).json({ shiftTypes: await venueShiftTypes(locationId), skipped });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'A shift type with one of those names was added a moment ago — try again.', errorCode: 'shift_type_name_taken' });
    console.error('[shiftTypes.bulk] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the shift types.' });
  }
});

/**
 * PATCH /api/shift-types/:locationId/:id — body: ShiftTypePatch → { shiftType }. 404 for another venue's id,
 * 409 for a name the venue already uses. New times apply to shifts made from now on; existing shifts keep theirs.
 */
shiftTypesRouter.patch('/:locationId/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId, id } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const current = await prisma.shiftType.findUnique({ where: { id } });
    if (!current || current.locationId !== locationId) return res.status(404).json({ error: `Shift type "${id}" not found.` });
    const parsed = parseShiftTypeInput(req.body, true);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message });
    const patch = parsed.value;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change: send name, ranges, tint or sortOrder.' });
    if (patch.name !== undefined && !sameName(patch.name, current.name)) {
      const clash = await prisma.shiftType.findMany({ where: { locationId, id: { not: id } }, select: { name: true } });
      if (clash.some((t) => sameName(t.name, patch.name!))) return res.status(409).json({ error: `There is already a shift type called "${patch.name}".`, errorCode: 'shift_type_name_taken' });
    }
    const updated = await withAuditedTransaction(
      prisma,
      (tx) =>
        tx.shiftType.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.ranges !== undefined ? { ranges: patch.ranges as unknown as Prisma.InputJsonValue, endsNextDay: rangesEndNextDay(patch.ranges) } : {}),
            ...(patch.tint !== undefined ? { tint: patch.tint } : {}),
            ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
          },
        }),
      (t) => ({
        locationId,
        actorId: req.user!.id,
        action: 'SHIFT_TYPE_UPDATED',
        entityType: 'ShiftType',
        entityId: t.id,
        note: `Updated shift type "${current.name}" → ${describe({ name: t.name, ranges: validateRanges(t.ranges) ? t.ranges : [] })}`,
      }),
    );
    return res.status(200).json({ shiftType: shiftTypeToDto(updated) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'There is already a shift type with that name.', errorCode: 'shift_type_name_taken' });
    console.error('[shiftTypes.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the shift type.' });
  }
});

/**
 * POST /api/shift-types/:locationId/:id/archive → { shiftType }. The type leaves the grid's palette (no new
 * shift can be made from it); shifts already made from it keep their times and label. Idempotent.
 */
shiftTypesRouter.post('/:locationId/:id/archive', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId, id } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const current = await prisma.shiftType.findUnique({ where: { id } });
    if (!current || current.locationId !== locationId) return res.status(404).json({ error: `Shift type "${id}" not found.` });
    if (current.archivedAt) return res.status(200).json({ shiftType: shiftTypeToDto(current) });
    const archived = await withAuditedTransaction(
      prisma,
      (tx) => tx.shiftType.update({ where: { id }, data: { archivedAt: new Date() } }),
      (t) => ({ locationId, actorId: req.user!.id, action: 'SHIFT_TYPE_ARCHIVED', entityType: 'ShiftType', entityId: t.id, note: `Archived shift type "${t.name}"` }),
    );
    return res.status(200).json({ shiftType: shiftTypeToDto(archived) });
  } catch (err) {
    console.error('[shiftTypes.archive] failed', err);
    return res.status(500).json({ error: 'Unexpected error while archiving the shift type.' });
  }
});
