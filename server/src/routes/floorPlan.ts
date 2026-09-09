import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { rasterizePdfPageToPng, PdfRasterizeError } from '../parsing/pdfRasterize.js';
import { requireSession, requireManager, assertOwnsLocation, ownedOrNotFound } from '../middleware/requireSession.js';
import { writeAuditLog, withAuditedTransaction } from '../lib/auditLog.js';
import { notifyUser } from '../lib/push.js';
import { upsertSectionAssignment } from '../lib/actions/sectionActions.js';

/**
 * Floor Plan — Sections & Duties.
 *
 * Phase 1 (admin setup, once per venue): upload the venue's floor plan
 * image (PDF gets rasterized to PNG, reusing the same pypdfium2 step
 * already built for the Ollama vision fallback — no new tool needed) and
 * draw freeform polygon sections over it. Stored server-side (not on the
 * uploading device) since multiple staff view the same plan.
 *
 * Phase 2 (daily use): assign staff to sections for a shift date, via
 * either drag-and-drop or tap-to-pick (frontend concern — this route only
 * exposes the shared read/write surface both paths write through).
 */
export const floorPlanRouter = Router();

const UPLOAD_DIR = join(import.meta.dirname, '..', '..', 'uploads', 'floor-plans');

/**
 * Serves the actual uploaded floor-plan image bytes — mounted directly at
 * `/uploads/floor-plans` in `app.ts`, BEFORE the generic `/uploads` static
 * fallback, so it intercepts this one subpath. Same pattern, same reasoning,
 * as `policyDocumentFilesRouter` in `policyDocuments.ts` (see MEMORY.md):
 * this app authenticates via a Bearer header, not a cookie, so the file
 * itself has to be fetched with a real token and rendered from a `blob:`
 * URL client-side — a plain `<img src>`/`useImage` can't attach one.
 * `FloorPlanImage.fileUrl` values never change, so no data migration needed.
 */
export const floorPlanFilesRouter = Router();

/** Matches the `${randomUUID()}${extFor(...)}` shape every upload is stored under (see `extFor`, below) — rejects anything else before it ever reaches the filesystem. */
const SAFE_IMAGE_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp|gif)$/i;

floorPlanFilesRouter.get('/:filename', requireSession, async (req, res) => {
  try {
    const { filename } = req.params;
    if (!SAFE_IMAGE_FILENAME_RE.test(filename)) return res.status(404).json({ error: 'Image not found.' });

    const fileUrl = `/uploads/floor-plans/${filename}`;
    const image = await prisma.floorPlanImage.findFirst({ where: { fileUrl } });
    if (!ownedOrNotFound(req, res, image, 'Image not found.')) return;

    return res.sendFile(join(UPLOAD_DIR, filename));
  } catch (err) {
    console.error('[floorPlan.serveFile] failed', err);
    return res.status(500).json({ error: 'Unexpected error while serving the image.' });
  }
});

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — floor plan scans can be large
  fileFilter: (_req, file, cb) => {
    const allowedExt = /\.(pdf|png|jpe?g|webp|gif)$/i;
    if (file.mimetype === 'application/pdf' || IMAGE_MIME_TYPES.includes(file.mimetype) || allowedExt.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type "${file.mimetype || file.originalname}". Upload a .pdf, .png, .jpg, or .webp file.`));
    }
  },
});

function extFor(mimeType: string, originalName: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  const match = /\.[a-z0-9]+$/i.exec(originalName);
  return match ? match[0] : '.png';
}

/**
 * POST /api/floor-plan/upload
 * multipart/form-data: file=<pdf|png|jpg|webp|gif>, locationId=<string>
 *
 * Saves the venue floor-plan image server-side and records it as the
 * location's current plan. A PDF is rasterized to PNG first (page 1).
 */
floorPlanRouter.post('/upload', requireSession, requireManager, upload.single('file'), async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!assertOwnsLocation(req, res, locationId)) return;

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    let buffer = req.file.buffer;
    let mimeType = req.file.mimetype;
    const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(req.file.originalname);
    if (isPdf) {
      try {
        buffer = await rasterizePdfPageToPng(buffer);
        mimeType = 'image/png';
      } catch (err) {
        console.error('[floorPlan.upload] PDF rasterization failed', err);
        const message =
          err instanceof PdfRasterizeError
            ? 'Could not convert this PDF to an image. Try exporting/saving it as a PNG or JPG and uploading that instead.'
            : 'Unexpected error converting the PDF.';
        return res.status(422).json({ error: message });
      }
    }

    await mkdir(UPLOAD_DIR, { recursive: true });
    const filename = `${randomUUID()}${extFor(mimeType, req.file.originalname)}`;
    await writeFile(join(UPLOAD_DIR, filename), buffer);
    const fileUrl = `/uploads/floor-plans/${filename}`;

    const image = await prisma.floorPlanImage.create({
      data: {
        locationId,
        fileUrl,
        originalName: req.file.originalname,
        mimeType,
      },
    });

    return res.status(201).json({ image, sections: [] });
  } catch (err) {
    console.error('[floorPlan.upload] failed', err);
    return res.status(500).json({ error: 'Unexpected error while uploading the floor plan.' });
  }
});

/**
 * POST /api/floor-plan/sections
 * body: { locationId, floorPlanImageId, label, polygon: {x,y}[], paxCapacity, notes? }
 *
 * `polygon` points are fractions (0-1) of the image's width/height.
 */
floorPlanRouter.post('/sections', requireSession, requireManager, async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const floorPlanImageId = String(req.body?.floorPlanImageId ?? '').trim();
    const label = String(req.body?.label ?? '').trim();
    const polygon = req.body?.polygon;
    const paxCapacity = Number(req.body?.paxCapacity);
    const notes = req.body?.notes ? String(req.body.notes).trim() : null;

    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!floorPlanImageId) return res.status(400).json({ error: 'floorPlanImageId is required.' });
    if (!label) return res.status(400).json({ error: 'label is required.' });
    if (!Array.isArray(polygon) || polygon.length < 3) {
      return res.status(400).json({ error: 'polygon must have at least 3 points.' });
    }
    if (!polygon.every((p) => typeof p?.x === 'number' && typeof p?.y === 'number')) {
      return res.status(400).json({ error: 'polygon points must be {x, y} numbers.' });
    }
    if (!Number.isFinite(paxCapacity) || paxCapacity < 0) {
      return res.status(400).json({ error: 'paxCapacity must be a non-negative number.' });
    }
    if (!assertOwnsLocation(req, res, locationId)) return;

    const image = await prisma.floorPlanImage.findUnique({ where: { id: floorPlanImageId } });
    if (!image || image.locationId !== locationId) {
      return res.status(404).json({ error: 'Floor plan image not found for this location.' });
    }

    const sortOrder = await prisma.floorSection.count({ where: { floorPlanImageId } });
    const section = await prisma.floorSection.create({
      data: { locationId, floorPlanImageId, label, polygon, paxCapacity: Math.round(paxCapacity), notes, sortOrder },
    });
    return res.status(201).json({ section });
  } catch (err) {
    console.error('[floorPlan.sections.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the section.' });
  }
});

/** PATCH /api/floor-plan/sections/:sectionId — edit label/polygon/paxCapacity/notes. */
floorPlanRouter.patch('/sections/:sectionId', requireSession, requireManager, async (req, res) => {
  try {
    const { sectionId } = req.params;
    const existing = await prisma.floorSection.findUnique({ where: { id: sectionId } });
    if (!ownedOrNotFound(req, res, existing, `Section "${sectionId}" not found.`)) return;

    const data: { label?: string; polygon?: { x: number; y: number }[]; paxCapacity?: number; notes?: string | null } = {};
    if (req.body?.label !== undefined) {
      const label = String(req.body.label).trim();
      if (!label) return res.status(400).json({ error: 'label cannot be empty.' });
      data.label = label;
    }
    if (req.body?.polygon !== undefined) {
      const polygon = req.body.polygon;
      if (!Array.isArray(polygon) || polygon.length < 3 || !polygon.every((p) => typeof p?.x === 'number' && typeof p?.y === 'number')) {
        return res.status(400).json({ error: 'polygon must be an array of at least 3 {x, y} points.' });
      }
      data.polygon = polygon;
    }
    if (req.body?.paxCapacity !== undefined) {
      const paxCapacity = Number(req.body.paxCapacity);
      if (!Number.isFinite(paxCapacity) || paxCapacity < 0) {
        return res.status(400).json({ error: 'paxCapacity must be a non-negative number.' });
      }
      data.paxCapacity = Math.round(paxCapacity);
    }
    if (req.body?.notes !== undefined) {
      const notes = req.body.notes === null ? null : String(req.body.notes).trim();
      data.notes = notes || null;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const section = await prisma.floorSection.update({ where: { id: sectionId }, data });
    return res.status(200).json({ section });
  } catch (err) {
    console.error('[floorPlan.sections.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating the section.' });
  }
});

/** DELETE /api/floor-plan/sections/:sectionId — also removes its assignments (cascade). */
floorPlanRouter.delete('/sections/:sectionId', requireSession, requireManager, async (req, res) => {
  try {
    const { sectionId } = req.params;
    const existing = await prisma.floorSection.findUnique({ where: { id: sectionId } });
    if (!ownedOrNotFound(req, res, existing, `Section "${sectionId}" not found.`)) return;
    await prisma.floorSection.delete({ where: { id: sectionId } });
    return res.status(204).send();
  } catch (err) {
    console.error('[floorPlan.sections.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the section.' });
  }
});

/**
 * GET /api/floor-plan/:locationId
 *
 * Returns the location's current (most recently uploaded) floor plan image
 * and its sections, or `image: null` if nothing has been uploaded yet.
 */
floorPlanRouter.get('/:locationId', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const image = await prisma.floorPlanImage.findFirst({
      where: { locationId },
      orderBy: { createdAt: 'desc' },
    });
    if (!image) return res.status(200).json({ image: null, sections: [] });

    const sections = await prisma.floorSection.findMany({
      where: { floorPlanImageId: image.id },
      orderBy: { sortOrder: 'asc' },
    });
    return res.status(200).json({ image, sections });
  } catch (err) {
    console.error('[floorPlan.get] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the floor plan.' });
  }
});

/**
 * GET /api/floor-plan/:locationId/assignments?date=YYYY-MM-DD&period=AM|PM
 *
 * Returns every section for the location's current floor plan, each with
 * its assignments for that date AND period embedded.
 */
floorPlanRouter.get('/:locationId/assignments', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const date = String(req.query.date ?? '').trim();
    const period = String(req.query.period ?? '').trim().toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date query param is required, as YYYY-MM-DD.' });
    }
    if (period !== 'AM' && period !== 'PM') {
      return res.status(400).json({ error: 'period query param is required, as AM or PM.' });
    }
    const shiftDate = new Date(`${date}T00:00:00.000Z`);

    const image = await prisma.floorPlanImage.findFirst({
      where: { locationId },
      orderBy: { createdAt: 'desc' },
    });
    if (!image) return res.status(200).json({ image: null, sections: [] });

    const sections = await prisma.floorSection.findMany({
      where: { floorPlanImageId: image.id },
      orderBy: { sortOrder: 'asc' },
      include: {
        assignments: {
          where: { shiftDate, period: period as 'AM' | 'PM' },
          include: { staff: { select: { id: true, fullName: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const shaped = sections.map((s) => ({
      id: s.id,
      label: s.label,
      polygon: s.polygon,
      paxCapacity: s.paxCapacity,
      notes: s.notes,
      assignments: s.assignments.map((a) => ({
        id: a.id,
        staffId: a.staffId,
        staffName: a.staff.fullName,
        dutyLabel: a.dutyLabel,
        status: a.status,
        notifiedAt: a.notifiedAt ? a.notifiedAt.toISOString() : null,
      })),
    }));

    return res.status(200).json({ image, sections: shaped });
  } catch (err) {
    console.error('[floorPlan.assignments.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading assignments.' });
  }
});

/**
 * GET /api/floor-plan/:locationId/my-assignments?staffId=&startDate=&endDate=
 *
 * A flat list of one staff member's PUBLISHED assignments across a date
 * range (Personal Rota's week), for the "You're covering: [section]" line
 * next to their shift cards — DRAFT assignments are deliberately excluded,
 * since nothing has actually been decided/notified for those yet. No extra
 * access check beyond the existing requireSession + assertOwnsLocation:
 * this exposes nothing a session at this venue can't already see via the
 * venue-wide `/assignments` endpoint above (unchanged by the Fix 1
 * role-based-UI pass, which only hid client-side controls, not server
 * reads), so a STAFF caller passing someone else's staffId is not a new
 * data-scoping hole.
 */
floorPlanRouter.get('/:locationId/my-assignments', requireSession, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const staffId = String(req.query.staffId ?? '').trim();
    const startDateStr = String(req.query.startDate ?? '').trim();
    const endDateStr = String(req.query.endDate ?? '').trim();
    if (!staffId) return res.status(400).json({ error: 'staffId query param is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
      return res.status(400).json({ error: 'startDate and endDate query params are required, as YYYY-MM-DD.' });
    }
    const startDate = new Date(`${startDateStr}T00:00:00.000Z`);
    const endDate = new Date(`${endDateStr}T00:00:00.000Z`);

    const rows = await prisma.sectionAssignment.findMany({
      where: {
        staffId,
        status: 'PUBLISHED',
        shiftDate: { gte: startDate, lte: endDate },
        section: { locationId },
      },
      include: { section: { select: { label: true } } },
      orderBy: { shiftDate: 'asc' },
    });

    return res.status(200).json({
      assignments: rows.map((a) => ({
        shiftDate: a.shiftDate.toISOString().slice(0, 10),
        period: a.period,
        sectionLabel: a.section.label,
      })),
    });
  } catch (err) {
    console.error('[floorPlan.myAssignments] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading assignments.' });
  }
});

/**
 * POST /api/floor-plan/assignments
 * body: { sectionId, staffId, shiftDate, period, dutyLabel? }
 * createdById is derived from the manager's own session, never from the body.
 */
floorPlanRouter.post('/assignments', requireSession, requireManager, async (req, res) => {
  try {
    const sectionId = String(req.body?.sectionId ?? '').trim();
    const staffId = String(req.body?.staffId ?? '').trim();
    const dateStr = String(req.body?.shiftDate ?? '').trim();
    const period = String(req.body?.period ?? '').trim().toUpperCase();
    // Distinguish "no dutyLabel key sent at all" (a plain drag-drop/tap
    // reassign — leave whatever label is already on the row alone) from
    // "dutyLabel explicitly sent, even empty/null" (a real clear or edit —
    // apply it). A truthy-or-null coercion can't tell these apart, and
    // conflating them means every re-assign of an already-labeled staff
    // member silently wipes their label.
    const hasDutyLabelKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'dutyLabel');
    const dutyLabel = hasDutyLabelKey && req.body.dutyLabel ? String(req.body.dutyLabel).trim() : null;
    const createdById = req.user!.id;

    if (!sectionId) return res.status(400).json({ error: 'sectionId is required.' });
    if (!staffId) return res.status(400).json({ error: 'staffId is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'shiftDate is required, as YYYY-MM-DD.' });
    }
    if (period !== 'AM' && period !== 'PM') {
      return res.status(400).json({ error: 'period is required, as AM or PM.' });
    }
    const shiftDate = new Date(`${dateStr}T00:00:00.000Z`);

    const section = await prisma.floorSection.findUnique({ where: { id: sectionId } });
    if (!ownedOrNotFound(req, res, section, `Section "${sectionId}" not found.`)) return;
    const staff = await prisma.user.findUnique({ where: { id: staffId } });
    if (!staff || staff.locationId !== section.locationId) {
      return res.status(404).json({ error: `Staff member "${staffId}" not found.` });
    }

    const assignment = await withAuditedTransaction(
      prisma,
      (tx) =>
        upsertSectionAssignment(
          { sectionId, staffId, shiftDate, period: period as 'AM' | 'PM', dutyLabel, createdById, touchDutyLabel: hasDutyLabelKey },
          tx,
        ),
      (upserted) => ({
        locationId: section.locationId,
        actorId: createdById,
        shiftId: null,
        action: 'SHIFT_ASSIGNED',
        entityType: 'SectionAssignment',
        entityId: upserted.id,
        note: `${staff.fullName} assigned to ${section.label} (${period})${dutyLabel ? ` — ${dutyLabel}` : ''}`,
      }),
    );

    return res.status(201).json({
      assignment: {
        id: assignment.id,
        sectionId: assignment.sectionId,
        staffId: assignment.staffId,
        staffName: assignment.staff.fullName,
        dutyLabel: assignment.dutyLabel,
        status: assignment.status,
        notifiedAt: assignment.notifiedAt ? assignment.notifiedAt.toISOString() : null,
      },
    });
  } catch (err) {
    console.error('[floorPlan.assignments.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the assignment.' });
  }
});

/** DELETE /api/floor-plan/assignments/:assignmentId — unassign. */
floorPlanRouter.delete('/assignments/:assignmentId', requireSession, requireManager, async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const existing = await prisma.sectionAssignment.findUnique({
      where: { id: assignmentId },
      include: { section: true, staff: { select: { fullName: true } } },
    });
    if (!existing) return res.status(404).json({ error: `Assignment "${assignmentId}" not found.` });
    if (!ownedOrNotFound(req, res, existing.section, `Assignment "${assignmentId}" not found.`)) return;

    const actorId = req.user!.id;
    await withAuditedTransaction(
      prisma,
      async (tx) => {
        // Audit-before-delete: writeAuditLog runs directly inside mutate (in
        // this original order), and buildEntry below returns null so the
        // helper doesn't also write a second row after the delete.
        await writeAuditLog(tx, {
          locationId: existing.section.locationId,
          actorId,
          shiftId: null,
          action: 'SHIFT_ASSIGNED',
          entityType: 'SectionAssignment',
          entityId: assignmentId,
          note: `${existing.staff.fullName} unassigned from ${existing.section.label} (${existing.period})`,
        });

        await tx.sectionAssignment.delete({ where: { id: assignmentId } });
      },
      () => null,
    );
    return res.status(204).send();
  } catch (err) {
    console.error('[floorPlan.assignments.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while removing the assignment.' });
  }
});

/**
 * PATCH /api/floor-plan/assignments/:assignmentId/notify
 *
 * Stamps `notifiedAt` for one assignment — a manager-initiated, honest
 * tracking event (no real push/SMS/WhatsApp send exists in this codebase).
 */
floorPlanRouter.patch('/assignments/:assignmentId/notify', requireSession, requireManager, async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const existing = await prisma.sectionAssignment.findUnique({
      where: { id: assignmentId },
      include: { section: true, staff: { select: { fullName: true } } },
    });
    if (!existing) return res.status(404).json({ error: `Assignment "${assignmentId}" not found.` });
    if (!ownedOrNotFound(req, res, existing.section, `Assignment "${assignmentId}" not found.`)) return;

    const actorId = req.user!.id;
    const notifiedAt = new Date();
    const updated = await withAuditedTransaction(
      prisma,
      (tx) =>
        tx.sectionAssignment.update({
          where: { id: assignmentId },
          data: { notifiedAt },
        }),
      () => ({
        locationId: existing.section.locationId,
        actorId,
        shiftId: null,
        action: 'ASSIGNMENT_NOTIFIED',
        entityType: 'SectionAssignment',
        entityId: assignmentId,
        note: `${existing.staff.fullName} marked notified for ${existing.section.label} (${existing.period})`,
      }),
    );

    // Real delivery on top of the existing flag-stamp above — never inside
    // the transaction (a push failure must not roll back notifiedAt, which
    // is a manager-facing "I did this" record independent of whether the
    // device-level send actually succeeds).
    const dateStr = existing.shiftDate.toISOString().slice(0, 10);
    void notifyUser(existing.staffId, {
      title: 'New section assignment',
      body: `You've been assigned to ${existing.section.label} for ${dateStr} (${existing.period}).`,
      url: '/my-shifts',
    });

    return res.status(200).json({ notifiedAt: updated.notifiedAt!.toISOString() });
  } catch (err) {
    console.error('[floorPlan.assignments.notify] failed', err);
    return res.status(500).json({ error: 'Unexpected error while marking the assignment notified.' });
  }
});

/**
 * POST /api/floor-plan/:locationId/publish
 * body: { shiftDate, period }
 *
 * Flips every DRAFT assignment for the location's sections on that date +
 * period to PUBLISHED, and stamps `notifiedAt` on each one at the same
 * moment — publishing IS the notify event for a freshly-published
 * assignment. A manager can still individually re-notify one person later
 * (e.g. after a reassignment) via the per-assignment notify endpoint.
 */
floorPlanRouter.post('/:locationId/publish', requireSession, requireManager, async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!assertOwnsLocation(req, res, locationId)) return;
    const dateStr = String(req.body?.shiftDate ?? '').trim();
    const period = String(req.body?.period ?? '').trim().toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'shiftDate is required, as YYYY-MM-DD.' });
    }
    if (period !== 'AM' && period !== 'PM') {
      return res.status(400).json({ error: 'period is required, as AM or PM.' });
    }
    const shiftDate = new Date(`${dateStr}T00:00:00.000Z`);
    const actorId = req.user!.id;
    const now = new Date();

    const result = await withAuditedTransaction(
      prisma,
      async (tx) => {
        // Captured BEFORE the update, on the same where-clause, so the
        // digest below knows exactly which staff/sections this call
        // actually flipped to PUBLISHED — updateMany itself only returns a
        // count, not the affected rows.
        const affected = await tx.sectionAssignment.findMany({
          where: { shiftDate, period: period as 'AM' | 'PM', status: 'DRAFT', section: { locationId } },
          select: { staffId: true, section: { select: { label: true } } },
        });
        const updateResult = await tx.sectionAssignment.updateMany({
          where: { shiftDate, period: period as 'AM' | 'PM', status: 'DRAFT', section: { locationId } },
          data: { status: 'PUBLISHED', publishedAt: now, notifiedAt: now },
        });
        return { count: updateResult.count, affected };
      },
      (updateResult) =>
        updateResult.count > 0
          ? {
              locationId,
              actorId,
              shiftId: null,
              action: 'ASSIGNMENT_NOTIFIED',
              entityType: 'SectionAssignment',
              entityId: locationId,
              note: `Published & notified ${updateResult.count} assignment${updateResult.count === 1 ? '' : 's'} for ${dateStr} (${period})`,
            }
          : null,
    );

    // Real delivery on top of the existing flag-stamp above (never inside
    // the transaction — see the per-assignment notify handler's comment).
    // One digest notification per affected staff member, not one per
    // assignment, so someone assigned to three sections in this batch gets
    // a single push, not three.
    const byStaff = new Map<string, string[]>();
    for (const a of result.affected) {
      const labels = byStaff.get(a.staffId) ?? [];
      labels.push(a.section.label);
      byStaff.set(a.staffId, labels);
    }
    for (const [staffId, labels] of byStaff) {
      void notifyUser(staffId, {
        title: 'New section assignment',
        body:
          labels.length === 1
            ? `You've been assigned to ${labels[0]} for ${dateStr} (${period}).`
            : `You've been assigned to ${labels.length} sections for ${dateStr} (${period}): ${labels.join(', ')}.`,
        url: '/my-shifts',
      });
    }

    return res.status(200).json({ publishedCount: result.count });
  } catch (err) {
    console.error('[floorPlan.publish] failed', err);
    return res.status(500).json({ error: 'Unexpected error while publishing assignments.' });
  }
});
