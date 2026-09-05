import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';

const prisma = new PrismaClient();

/** Starts the real Express app on an ephemeral port and hands the caller its base URL. */
async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Issues a real bearer session token for a real User, exactly like a login would. */
async function sessionFor(userId: string): Promise<string> {
  const { plainToken } = await issueSession(userId);
  return plainToken;
}

function pdfBody(): Blob {
  // A minimal, technically-invalid-but-multer-parseable PDF payload — the
  // route only reads req.file.buffer through to storage, never actually
  // parses the PDF, so real page content isn't needed for this test.
  return new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' });
}

// 2026-09-05 — closes a real, pre-existing gap the withAuditedTransaction
// review found: POST /upload and DELETE /:id were both requireSession-only,
// so any authenticated STAFF session could upload a compliance document
// under any category, or permanently delete an existing one — this file's
// own GET route comment already calls these "real sensitive data." No test
// file existed for this router at all before this fix.
test('policyDocuments.ts mutation routes reject a real STAFF session with 403 — POST /upload, DELETE /:id', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ policyDocuments requireManager', timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ manager', systemRole: 'MANAGER' },
  });
  const staff = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ staff', systemRole: 'STAFF' },
  });
  // fileUrl includes a fresh randomUUID (not a fixed literal) — after this
  // session's performance audit added a real @unique constraint on this
  // column (matching production's own always-randomUUID fileUrl shape), a
  // fixed literal here would collide with a stale leftover row from any
  // prior run of this test that crashed before its own cleanup ran, turning
  // an already-rare leftover into a hard P2002 at test setup instead of a
  // harmless (if untidy) duplicate — found by the mandatory review.
  const doc = await prisma.policyDocument.create({
    data: {
      locationId: location.id,
      category: 'other',
      title: '__authgap-test__ existing doc',
      fileUrl: `/uploads/policy-documents/__authgap-test__-${randomUUID()}.pdf`,
      originalName: 'existing.pdf',
      mimeType: 'application/pdf',
      uploadedById: manager.id,
    },
  });

  try {
    const staffToken = await sessionFor(staff.id);
    await withServer(async (baseUrl) => {
      const authHeader = { Authorization: `Bearer ${staffToken}` };

      const form = new FormData();
      form.append('category', 'other');
      form.append('title', '__authgap-test__ staff-attempted');
      form.append('file', pdfBody(), 'staff-attempt.pdf');
      const upload = await fetch(`${baseUrl}/api/policy-documents/upload`, { method: 'POST', headers: authHeader, body: form });
      assert.equal(upload.status, 403, 'POST /upload must reject a STAFF session');

      const del = await fetch(`${baseUrl}/api/policy-documents/${doc.id}`, { method: 'DELETE', headers: authHeader });
      assert.equal(del.status, 403, 'DELETE /:id must reject a STAFF session');
    });

    // Nothing any of the rejected calls attempted should have actually landed.
    const docs = await prisma.policyDocument.findMany({ where: { locationId: location.id } });
    assert.equal(docs.length, 1, 'only the original document should exist — no STAFF mutation attempt should have succeeded');
    assert.equal(docs[0]!.id, doc.id);
  } finally {
    await prisma.policyDocument.deleteMany({ where: { locationId: location.id } });
    await prisma.user.delete({ where: { id: staff.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});

// Companion to the STAFF-403 test: proves adding requireManager didn't also
// break the legitimate case.
test('policyDocuments.ts mutation routes still work normally for a real MANAGER session — POST /upload, DELETE /:id', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (a location) must exist to run this test');

  const location = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__authgap-test__ policyDocuments still works', timezone: 'Asia/Dubai' },
  });
  const manager = await prisma.user.create({
    data: { locationId: location.id, fullName: '__authgap-test__ works manager', systemRole: 'MANAGER' },
  });

  try {
    const token = await sessionFor(manager.id);
    let docId = '';
    await withServer(async (baseUrl) => {
      const authHeader = { Authorization: `Bearer ${token}` };

      const form = new FormData();
      form.append('category', 'other');
      form.append('title', '__authgap-test__ works doc');
      form.append('file', pdfBody(), 'works.pdf');
      const upload = await fetch(`${baseUrl}/api/policy-documents/upload`, { method: 'POST', headers: authHeader, body: form });
      assert.equal(upload.status, 201, 'a real manager session must still be able to upload a document');
      const uploadBody = (await upload.json()) as { document: { id: string } };
      docId = uploadBody.document.id;

      const del = await fetch(`${baseUrl}/api/policy-documents/${docId}`, { method: 'DELETE', headers: authHeader });
      assert.equal(del.status, 204, 'a real manager session must still be able to delete a document');
    });

    const docs = await prisma.policyDocument.findMany({ where: { locationId: location.id } });
    assert.equal(docs.length, 0, 'the document must have actually been deleted');
  } finally {
    await prisma.policyDocument.deleteMany({ where: { locationId: location.id } });
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
  }
});
