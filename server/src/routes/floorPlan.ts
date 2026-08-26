import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { rasterizePdfPageToPng, PdfRasterizeError } from '../parsing/pdfRasterize.js';

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
floorPlanRouter.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

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
floorPlanRouter.post('/sections', async (req, res) => {
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
floorPlanRouter.patch('/sections/:sectionId', async (req, res) => {
  try {
    const { sectionId } = req.params;
    const existing = await prisma.floorSection.findUnique({ where: { id: sectionId } });
    if (!existing) return res.status(404).json({ error: `Section "${sectionId}" not found.` });

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
floorPlanRouter.delete('/sections/:sectionId', async (req, res) => {
  try {
    const { sectionId } = req.params;
    const existing = await prisma.floorSection.findUnique({ where: { id: sectionId } });
    if (!existing) return res.status(404).json({ error: `Section "${sectionId}" not found.` });
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
floorPlanRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
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
 * GET /api/floor-plan/:locationId/assignments?date=YYYY-MM-DD
 *
 * Returns every section for the location's current floor plan, each with
 * its assignments for that date embedded — the daily assignment screen
 * renders straight from this, no client-side joining needed.
 */
floorPlanRouter.get('/:locationId/assignments', async (req, res) => {
  try {
    const { locationId } = req.params;
    const date = String(req.query.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date query param is required, as YYYY-MM-DD.' });
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
          where: { shiftDate },
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
      })),
    }));

    return res.status(200).json({ image, sections: shaped });
  } catch (err) {
    console.error('[floorPlan.assignments.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading assignments.' });
  }
});

/**
 * POST /api/floor-plan/assignments
 * body: { sectionId, staffId, shiftDate, dutyLabel?, createdById? }
 *
 * Shared write path for both drag-and-drop and tap-to-pick. Upserts on the
 * (sectionId, staffId, shiftDate) unique constraint so re-assigning the
 * same person to the same section on the same day is a no-op update
 * (e.g. changing the duty label) instead of a duplicate-key error.
 */
floorPlanRouter.post('/assignments', async (req, res) => {
  try {
    const sectionId = String(req.body?.sectionId ?? '').trim();
    const staffId = String(req.body?.staffId ?? '').trim();
    const dateStr = String(req.body?.shiftDate ?? '').trim();
    const dutyLabel = req.body?.dutyLabel ? String(req.body.dutyLabel).trim() : null;
    const createdById = req.body?.createdById ? String(req.body.createdById).trim() : null;

    if (!sectionId) return res.status(400).json({ error: 'sectionId is required.' });
    if (!staffId) return res.status(400).json({ error: 'staffId is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'shiftDate is required, as YYYY-MM-DD.' });
    }
    const shiftDate = new Date(`${dateStr}T00:00:00.000Z`);

    const section = await prisma.floorSection.findUnique({ where: { id: sectionId } });
    if (!section) return res.status(404).json({ error: `Section "${sectionId}" not found.` });
    const staff = await prisma.user.findUnique({ where: { id: staffId } });
    if (!staff) return res.status(404).json({ error: `Staff member "${staffId}" not found.` });

    const assignment = await prisma.sectionAssignment.upsert({
      where: { sectionId_staffId_shiftDate: { sectionId, staffId, shiftDate } },
      create: { sectionId, staffId, shiftDate, dutyLabel, createdById },
      update: { dutyLabel },
      include: { staff: { select: { id: true, fullName: true } } },
    });

    return res.status(201).json({
      assignment: {
        id: assignment.id,
        sectionId: assignment.sectionId,
        staffId: assignment.staffId,
        staffName: assignment.staff.fullName,
        dutyLabel: assignment.dutyLabel,
        status: assignment.status,
      },
    });
  } catch (err) {
    console.error('[floorPlan.assignments.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the assignment.' });
  }
});

/** DELETE /api/floor-plan/assignments/:assignmentId — unassign. */
floorPlanRouter.delete('/assignments/:assignmentId', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const existing = await prisma.sectionAssignment.findUnique({ where: { id: assignmentId } });
    if (!existing) return res.status(404).json({ error: `Assignment "${assignmentId}" not found.` });
    await prisma.sectionAssignment.delete({ where: { id: assignmentId } });
    return res.status(204).send();
  } catch (err) {
    console.error('[floorPlan.assignments.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while removing the assignment.' });
  }
});

/**
 * POST /api/floor-plan/:locationId/publish
 * body: { shiftDate }
 *
 * Flips every DRAFT assignment for the location's sections on that date to
 * PUBLISHED. Assignment writes only — no notification is sent (that's
 * gated behind the separate build-vs-OneSignal decision).
 */
floorPlanRouter.post('/:locationId/publish', async (req, res) => {
  try {
    const { locationId } = req.params;
    const dateStr = String(req.body?.shiftDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'shiftDate is required, as YYYY-MM-DD.' });
    }
    const shiftDate = new Date(`${dateStr}T00:00:00.000Z`);

    const result = await prisma.sectionAssignment.updateMany({
      where: { shiftDate, status: 'DRAFT', section: { locationId } },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });

    return res.status(200).json({ publishedCount: result.count });
  } catch (err) {
    console.error('[floorPlan.publish] failed', err);
    return res.status(500).json({ error: 'Unexpected error while publishing assignments.' });
  }
});
