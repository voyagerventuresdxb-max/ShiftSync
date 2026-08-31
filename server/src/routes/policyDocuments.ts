import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { requireSession, ownedOrNotFound } from '../middleware/requireSession.js';
import { writeAuditLog } from '../lib/auditLog.js';

export const policyDocumentsRouter = Router();

const UPLOAD_DIR = join(import.meta.dirname, '..', '..', 'uploads', 'policy-documents');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
    else cb(new Error(`Unsupported file type "${file.mimetype || file.originalname}". Upload a .pdf file.`));
  },
});

/** GET /api/policy-documents/:locationId — grouped by category client-side; server returns a flat list. */
policyDocumentsRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const docs = await prisma.policyDocument.findMany({
      where: { locationId },
      orderBy: [{ category: 'asc' }, { createdAt: 'desc' }],
    });
    return res.status(200).json({
      documents: docs.map((d) => ({
        id: d.id,
        category: d.category,
        title: d.title,
        fileUrl: d.fileUrl,
        originalName: d.originalName,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[policyDocuments.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading documents.' });
  }
});

/**
 * POST /api/policy-documents/upload — multipart: file, category, title, uploadedById?
 * Session-gated; `locationId` comes from the session, not the body.
 * `uploadedById` is only honored for a MANAGER/OWNER session — same
 * on-behalf-of rule used across every other hardened route.
 */
policyDocumentsRouter.post('/upload', requireSession, upload.single('file'), async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    const category = String(req.body?.category ?? '').trim();
    const title = String(req.body?.title ?? '').trim();
    const uploadedById =
      req.user!.systemRole === 'STAFF'
        ? req.user!.id
        : (req.body?.uploadedById ? String(req.body.uploadedById).trim() : '') || req.user!.id;
    if (!category) return res.status(400).json({ error: 'category is required.' });
    if (!title) return res.status(400).json({ error: 'title is required.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    await mkdir(UPLOAD_DIR, { recursive: true });
    const filename = `${randomUUID()}.pdf`;
    await writeFile(join(UPLOAD_DIR, filename), req.file.buffer);
    const fileUrl = `/uploads/policy-documents/${filename}`;

    const doc = await prisma.policyDocument.create({
      data: { locationId, category, title, fileUrl, originalName: req.file.originalname, mimeType: req.file.mimetype, uploadedById },
    });
    await writeAuditLog(prisma, {
      locationId,
      actorId: req.user!.id,
      action: 'POLICY_DOCUMENT_UPLOADED',
      entityType: 'PolicyDocument',
      entityId: doc.id,
      note: `Uploaded "${title}" (${category})`,
    });
    return res.status(201).json({
      document: { id: doc.id, category: doc.category, title: doc.title, fileUrl: doc.fileUrl, originalName: doc.originalName, createdAt: doc.createdAt.toISOString() },
    });
  } catch (err) {
    console.error('[policyDocuments.upload] failed', err);
    return res.status(500).json({ error: 'Unexpected error while uploading the document.' });
  }
});

/** DELETE /api/policy-documents/:id — session-gated, own venue only. */
policyDocumentsRouter.delete('/:id', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.policyDocument.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Document "${id}" not found.`)) return;
    await prisma.policyDocument.delete({ where: { id } });
    await writeAuditLog(prisma, {
      locationId: existing.locationId,
      actorId: req.user!.id,
      action: 'POLICY_DOCUMENT_DELETED',
      entityType: 'PolicyDocument',
      entityId: id,
      note: `Deleted "${existing.title}" (${existing.category})`,
    });
    return res.status(204).send();
  } catch (err) {
    console.error('[policyDocuments.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the document.' });
  }
});
