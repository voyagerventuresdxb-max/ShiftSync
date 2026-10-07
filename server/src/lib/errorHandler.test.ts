import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from './identity.js';
import { apiErrorHandler, GENERIC_ERROR_MESSAGE, INVALID_JSON_MESSAGE, UploadRejectedError } from './errorHandler.js';

const prisma = new PrismaClient();
const TAG = '__error-handler-test__';

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let mini: { server: Server; base: string };
let real: { server: Server; base: string };
let orgId = '';
let managerToken = '';

before(async () => {
  const app = express();
  app.use(express.json());
  app.get('/boom', () => {
    throw new Error('connect ECONNREFUSED db.internal:5432 (secret detail)');
  });
  app.get('/rejected', (_req, _res, next) => next(new UploadRejectedError('Unsupported file type "text/plain". Upload a .pdf file.')));
  app.get('/too-big', (_req, _res, next) => next(new multer.MulterError('LIMIT_FILE_SIZE')));
  app.post('/json', (_req, res) => res.json({ ok: true }));
  app.use(apiErrorHandler);
  mini = await listen(app);
  real = await listen(createApp());

  const org = await prisma.organization.create({ data: { name: `${TAG} ${Date.now()}` } });
  orgId = org.id;
  const location = await prisma.location.create({ data: { organizationId: org.id, name: `${TAG} venue` } });
  const manager = await prisma.user.create({ data: { locationId: location.id, systemRole: 'MANAGER', fullName: `${TAG} manager` } });
  managerToken = (await issueSession(manager.id)).plainToken;
});

after(async () => {
  await new Promise<void>((r) => mini.server.close(() => r()));
  await new Promise<void>((r) => real.server.close(() => r()));
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('an unexpected error answers with a generic message; the real error is logged on the server', async () => {
  const logged = mock.method(console, 'error', () => {});
  try {
    const res = await fetch(`${mini.base}/boom`);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: GENERIC_ERROR_MESSAGE });
    assert.ok(!text.includes('secret') && !text.includes('ECONNREFUSED'), 'no internal detail reaches the caller');
    const loggedErr = logged.mock.calls.map((c) => c.arguments[1]).find((a) => a instanceof Error) as Error | undefined;
    assert.match(loggedErr?.message ?? '', /secret detail/, 'the real error is in the server log');
  } finally {
    logged.mock.restore();
  }
});

test('upload refusals keep a message the person can act on', async () => {
  const logged = mock.method(console, 'error', () => {});
  try {
    const rejected = await fetch(`${mini.base}/rejected`);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'Unsupported file type "text/plain". Upload a .pdf file.' });
    const tooBig = await fetch(`${mini.base}/too-big`);
    assert.equal(tooBig.status, 400);
    assert.deepEqual(await tooBig.json(), { error: 'File too large' });
  } finally {
    logged.mock.restore();
  }
});

test('a malformed JSON body gets a fixed message, not the parser text', async () => {
  const logged = mock.method(console, 'error', () => {});
  try {
    for (const base of [mini.base, real.base]) {
      const path = base === mini.base ? '/json' : '/api/identity/request-otp';
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"phone": ' });
      assert.equal(res.status, 400, base);
      assert.deepEqual(await res.json(), { error: INVALID_JSON_MESSAGE }, base);
    }
  } finally {
    logged.mock.restore();
  }
});

test("through the real app: a route's file-type check still reaches the person", async () => {
  const logged = mock.method(console, 'error', () => {});
  try {
    const form = new FormData();
    form.append('file', new Blob(['not a pdf'], { type: 'text/plain' }), 'notes.txt');
    form.append('title', 'Notes');
    form.append('category', 'Safety');
    const res = await fetch(`${real.base}/api/policy-documents/upload`, { method: 'POST', headers: { Authorization: `Bearer ${managerToken}` }, body: form });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /^Unsupported file type "text\/plain"\. Upload a \.pdf file\.$/);
  } finally {
    logged.mock.restore();
  }
});
