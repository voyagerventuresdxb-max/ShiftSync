import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, assertOwnsLocation } from '../middleware/requireSession.js';
import { SHIFT_TINTS, type DepartmentDto, type DepartmentInput, type DepartmentMinimumDto, type ShiftTint } from '../../../shared/rotaWeek.js';

/**
 * Rota builder v2 — a venue's departments (Floor, Bar, Kitchen, Hosts…), the
 * roles grouped under each, and the optional per-weekday minimum headcounts
 * that drive only the coverage row's "uncovered" flag (shared/rotaWeek.ts:
 * DepartmentInput, DepartmentMinimumDto). Any session of the venue may read;
 * writes are manager-only. Roles without a department show under "Other" in
 * the week document.
 */
export const departmentsRouter = Router();

const NAME_MAX = 40;

async function departmentDto(id: string): Promise<DepartmentDto> {
  const d = await prisma.department.findUniqueOrThrow({ where: { id }, include: { roles: { select: { id: true }, orderBy: { name: 'asc' } } } });
  return toDto(d);
}

function toDto(d: { id: string; name: string; tint: string; sortOrder: number; roles: { id: string }[] }): DepartmentDto {
  const tint = (SHIFT_TINTS as readonly string[]).includes(d.tint) ? (d.tint as ShiftTint) : 'cream';
  return { id: d.id, name: d.name, tint, sortOrder: d.sortOrder, roleIds: d.roles.map((r) => r.id) };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Checks a full (create) or partial (patch) DepartmentInput; returns only the fields that were sent. */
function parseDepartmentInput(body: unknown, partial: boolean): Parsed<Partial<DepartmentInput>> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<DepartmentInput> = {};
  if (b.name !== undefined || !partial) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { ok: false, message: 'name is required.' };
    if (b.name.trim().length > NAME_MAX) return { ok: false, message: `name is at most ${NAME_MAX} characters.` };
    out.name = b.name.trim();
  }
  if (b.tint !== undefined || !partial) {
    if (typeof b.tint !== 'string' || !(SHIFT_TINTS as readonly string[]).includes(b.tint)) return { ok: false, message: `tint must be one of ${SHIFT_TINTS.join(', ')}.` };
    out.tint = b.tint as ShiftTint;
  }
  if (b.sortOrder !== undefined) {
    if (typeof b.sortOrder !== 'number' || !Number.isInteger(b.sortOrder) || b.sortOrder < 0 || b.sortOrder > 999) return { ok: false, message: 'sortOrder must be a whole number from 0 to 999.' };
    out.sortOrder = b.sortOrder;
  }
  if (b.roleIds !== undefined) {
    if (!Array.isArray(b.roleIds) || b.roleIds.some((r) => typeof r !== 'string' || !r)) return { ok: false, message: 'roleIds must be an array of role ids.' };
    out.roleIds = [...new Set(b.roleIds as string[])];
  }
  return { ok: true, value: out };
}

/** Every listed role must be one of this venue's; a role of another venue is reported as not found. */
async function assertVenueRoles(locationId: string, roleIds: string[]): Promise<string | null> {
  if (roleIds.length === 0) return null;
  const found = await prisma.role.findMany({ where: { id: { in: roleIds }, locationId }, select: { id: true } });
  const ok = new Set(found.map((r) => r.id));
  return roleIds.find((id) => !ok.has(id)) ?? null;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** GET /api/departments/:locationId → { departments, minimums }. Any session of the venue. */
departmentsRouter.get('/:locationId', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const departments = await prisma.department.findMany({
      where: { locationId },
      include: { roles: { select: { id: true }, orderBy: { name: 'asc' } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const minimums = await prisma.departmentMinimum.findMany({ where: { locationId }, orderBy: [{ departmentId: 'asc' }, { weekday: 'asc' }] });
    return res.status(200).json({
      departments: departments.map(toDto),
      minimums: minimums.map((m): DepartmentMinimumDto => ({ departmentId: m.departmentId, weekday: m.weekday, minHeadcount: m.minHeadcount })),
    });
  } catch (err) {
    console.error('[departments.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading departments.' });
  }
});

/** POST /api/departments/:locationId — body: DepartmentInput → 201 { department }. 409 when the name is taken. */
departmentsRouter.post('/:locationId', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const parsed = parseDepartmentInput(req.body, false);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message });
    const input = parsed.value as DepartmentInput;
    const existing = await prisma.department.findMany({ where: { locationId }, select: { name: true, sortOrder: true } });
    if (existing.some((d) => sameName(d.name, input.name))) return res.status(409).json({ error: `There is already a department called "${input.name}".`, errorCode: 'department_name_taken' });
    const badRole = await assertVenueRoles(locationId, input.roleIds ?? []);
    if (badRole) return res.status(404).json({ error: `Role "${badRole}" not found.` });
    const created = await prisma.$transaction(async (tx) => {
      const department = await tx.department.create({
        data: { locationId, name: input.name, tint: input.tint, sortOrder: input.sortOrder ?? existing.reduce((max, d) => Math.max(max, d.sortOrder + 1), 0) },
      });
      if (input.roleIds?.length) await tx.role.updateMany({ where: { id: { in: input.roleIds }, locationId }, data: { departmentId: department.id } });
      return department;
    });
    return res.status(201).json({ department: await departmentDto(created.id) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'There is already a department with that name.', errorCode: 'department_name_taken' });
    console.error('[departments.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the department.' });
  }
});

/**
 * PATCH /api/departments/:locationId/:id — body: { name?, tint?, sortOrder?, roleIds? } → { department }.
 * `roleIds` REPLACES the set of roles grouped under this department: listed roles move here (from wherever they
 * were), roles no longer listed become ungrouped ("Other"). Every role must be this venue's (else 404).
 */
departmentsRouter.patch('/:locationId/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId, id } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const current = await prisma.department.findUnique({ where: { id } });
    if (!current || current.locationId !== locationId) return res.status(404).json({ error: `Department "${id}" not found.` });
    const parsed = parseDepartmentInput(req.body, true);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message });
    const patch = parsed.value;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change: send name, tint, sortOrder or roleIds.' });
    if (patch.name !== undefined && !sameName(patch.name, current.name)) {
      const others = await prisma.department.findMany({ where: { locationId, id: { not: id } }, select: { name: true } });
      if (others.some((d) => sameName(d.name, patch.name!))) return res.status(409).json({ error: `There is already a department called "${patch.name}".`, errorCode: 'department_name_taken' });
    }
    if (patch.roleIds) {
      const badRole = await assertVenueRoles(locationId, patch.roleIds);
      if (badRole) return res.status(404).json({ error: `Role "${badRole}" not found.` });
    }
    await prisma.$transaction(async (tx) => {
      await tx.department.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.tint !== undefined ? { tint: patch.tint } : {}),
          ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        },
      });
      if (patch.roleIds) {
        await tx.role.updateMany({ where: { locationId, departmentId: id, id: { notIn: patch.roleIds } }, data: { departmentId: null } });
        if (patch.roleIds.length > 0) await tx.role.updateMany({ where: { locationId, id: { in: patch.roleIds } }, data: { departmentId: id } });
      }
    });
    return res.status(200).json({ department: await departmentDto(id) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'There is already a department with that name.', errorCode: 'department_name_taken' });
    console.error('[departments.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the department.' });
  }
});

/**
 * PUT /api/departments/:locationId/:id/minimums — body: { minimums: { weekday, minHeadcount }[] } → { minimums }.
 * Replaces this department's minimums: weekday 0 (Sunday) … 6 (Saturday), each at most once; a 0 headcount (or
 * a weekday left out) means no minimum that day. Only the coverage row reads them; nothing is ever blocked.
 */
departmentsRouter.put('/:locationId/:id/minimums', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId, id } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const department = await prisma.department.findUnique({ where: { id } });
    if (!department || department.locationId !== locationId) return res.status(404).json({ error: `Department "${id}" not found.` });
    const raw = req.body?.minimums;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'minimums must be an array of { weekday, minHeadcount }.' });
    const seen = new Set<number>();
    const rows: { weekday: number; minHeadcount: number }[] = [];
    for (const item of raw as unknown[]) {
      const m = (item ?? {}) as Record<string, unknown>;
      const weekday = m.weekday;
      const minHeadcount = m.minHeadcount;
      if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: 'weekday must be 0 (Sunday) to 6 (Saturday).' });
      if (typeof minHeadcount !== 'number' || !Number.isInteger(minHeadcount) || minHeadcount < 0 || minHeadcount > 99) return res.status(400).json({ error: 'minHeadcount must be a whole number from 0 to 99.' });
      if (seen.has(weekday)) return res.status(400).json({ error: `weekday ${weekday} is listed twice.` });
      seen.add(weekday);
      if (minHeadcount > 0) rows.push({ weekday, minHeadcount });
    }
    await prisma.$transaction(async (tx) => {
      await tx.departmentMinimum.deleteMany({ where: { departmentId: id } });
      if (rows.length > 0) await tx.departmentMinimum.createMany({ data: rows.map((r) => ({ locationId, departmentId: id, ...r })) });
    });
    const saved = await prisma.departmentMinimum.findMany({ where: { departmentId: id }, orderBy: { weekday: 'asc' } });
    return res.status(200).json({ minimums: saved.map((m): DepartmentMinimumDto => ({ departmentId: m.departmentId, weekday: m.weekday, minHeadcount: m.minHeadcount })) });
  } catch (err) {
    console.error('[departments.minimums] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the minimums.' });
  }
});
