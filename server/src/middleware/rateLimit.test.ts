import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { requireSession } from './requireSession.js';
import { transcribeRateLimiter, parseIntentRateLimiter, rosterUploadRateLimiter } from './rateLimit.js';
import { issueSession } from '../lib/identity.js';

const prisma = new PrismaClient();

/**
 * These tests exercise the REAL `transcribeRateLimiter`/`parseIntentRateLimiter`/
 * `rosterUploadRateLimiter` singletons (the exact instances `voice.ts` mounts
 * on /transcribe and /parse-intent, and `schedules.ts` mounts on /upload) and
 * a REAL `requireSession` + real DB-backed sessions — matching this
 * codebase's no-mocking convention (see voice.test.ts). What they
 * deliberately do NOT do is exercise the real route handlers, which would
 * call the real (paid, rate-limited-by-the-provider) Gemini API — or, for
 * roster uploads, potentially a local Ollama/Docling call too — on every one
 * of the dozens of requests a threshold test needs to send. A dummy 200
 * handler proves the exact same thing about the limiter itself (it is keyed
 * by req.user.id, mounted after requireSession, trips at the configured
 * threshold, and shapes its 429 body like this codebase's other error
 * responses) without spending a single real provider call to do it.
 *
 * Two of the tests below (the "skip-failed" pair) instead point the limiter
 * at a handler that always FAILS, to prove `skipFailedRequests` is configured
 * oppositely on purpose between the voice routes (true — their only failure
 * mode is a genuine provider outage) and the roster-upload route (false — its
 * failures routinely follow a real, already-spent AI call).
 */
function buildLimiterTestApp(limiter: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post('/test/limited', requireSession, limiter, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

/** Same shape, but the handler always answers with the given (failure) status — for skipFailedRequests coverage. */
function buildFailingLimiterTestApp(limiter: express.RequestHandler, failureStatus: number) {
  const app = express();
  app.use(express.json());
  app.post('/test/limited', requireSession, limiter, (_req, res) => res.status(failureStatus).json({ error: 'simulated failure' }));
  return app;
}

async function withServer<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
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

async function post(baseUrl: string, token: string) {
  return fetch(`${baseUrl}/test/limited`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
}

test('transcribeRateLimiter: trips 429 at the configured threshold (20/5min) for one user, and leaves a different user unaffected', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const userA = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__ratelimit-test__ transcribe user A', systemRole: 'STAFF' },
  });
  const userB = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__ratelimit-test__ transcribe user B', systemRole: 'STAFF' },
  });

  try {
    const tokenA = await sessionFor(userA.id);
    const tokenB = await sessionFor(userB.id);
    const app = buildLimiterTestApp(transcribeRateLimiter);

    await withServer(app, async (baseUrl) => {
      // First 20 requests from user A must all succeed — this IS the
      // configured allowance, not an arbitrary smaller number.
      for (let i = 0; i < 20; i++) {
        const res = await post(baseUrl, tokenA);
        assert.equal(res.status, 200, `request #${i + 1} from user A should be within the 20-request allowance`);
      }

      // The 21st request from the SAME user must be rejected, with this
      // codebase's error-response shape — not express-rate-limit's default
      // HTML/text body.
      const limited = await post(baseUrl, tokenA);
      assert.equal(limited.status, 429, 'the 21st request from the same user within the window must be rate limited');
      assert.equal(limited.headers.get('content-type')?.includes('application/json'), true, 'the 429 body must be JSON, not the library default HTML/text');
      const limitedBody = (await limited.json()) as { error: string };
      assert.equal(typeof limitedBody.error, 'string');
      assert.match(limitedBody.error, /too many/i);

      // A DIFFERENT user's session must be completely unaffected — proves
      // the limiter is keyed per-user (req.user.id), not globally or by IP
      // (both requests came from the same test process/IP).
      const otherUser = await post(baseUrl, tokenB);
      assert.equal(otherUser.status, 200, "a different user's session must not be rate limited by user A's usage");
    });
  } finally {
    await prisma.user.delete({ where: { id: userA.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: userB.id } }).catch(() => {});
  }
});

test('parseIntentRateLimiter: trips 429 at its configured threshold (30/5min) for one user, independent of the transcribe limiter', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const user = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__ratelimit-test__ parse-intent user', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(user.id);
    const app = buildLimiterTestApp(parseIntentRateLimiter);

    await withServer(app, async (baseUrl) => {
      for (let i = 0; i < 30; i++) {
        const res = await post(baseUrl, token);
        assert.equal(res.status, 200, `request #${i + 1} should be within the 30-request allowance`);
      }
      const limited = await post(baseUrl, token);
      assert.equal(limited.status, 429, 'the 31st request within the window must be rate limited');
      const body = (await limited.json()) as { error: string };
      assert.match(body.error, /too many/i);
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test('rosterUploadRateLimiter: trips 429 at its configured threshold (10/5min) for one user, and leaves a different user unaffected', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const userA = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__ratelimit-test__ roster-upload user A', systemRole: 'MANAGER' },
  });
  const userB = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__ratelimit-test__ roster-upload user B', systemRole: 'MANAGER' },
  });

  try {
    const tokenA = await sessionFor(userA.id);
    const tokenB = await sessionFor(userB.id);
    const app = buildLimiterTestApp(rosterUploadRateLimiter);

    await withServer(app, async (baseUrl) => {
      // First 10 requests from user A must all succeed — this IS the
      // configured allowance, not an arbitrary smaller number.
      for (let i = 0; i < 10; i++) {
        const res = await post(baseUrl, tokenA);
        assert.equal(res.status, 200, `request #${i + 1} from user A should be within the 10-request allowance`);
      }

      // The 11th request from the SAME user must be rejected, with this
      // codebase's error-response shape — not express-rate-limit's default
      // HTML/text body.
      const limited = await post(baseUrl, tokenA);
      assert.equal(limited.status, 429, 'the 11th request from the same user within the window must be rate limited');
      assert.equal(limited.headers.get('content-type')?.includes('application/json'), true, 'the 429 body must be JSON, not the library default HTML/text');
      const limitedBody = (await limited.json()) as { error: string };
      assert.equal(typeof limitedBody.error, 'string');
      assert.match(limitedBody.error, /too many/i);

      // A DIFFERENT user's session must be completely unaffected — proves
      // the limiter is keyed per-user (req.user.id), not globally or by IP
      // (both requests came from the same test process/IP).
      const otherUser = await post(baseUrl, tokenB);
      assert.equal(otherUser.status, 200, "a different user's session must not be rate limited by user A's usage");
    });
  } finally {
    await prisma.user.delete({ where: { id: userA.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: userB.id } }).catch(() => {});
  }
});

test('transcribeRateLimiter: skipFailedRequests is true — a run of failed (>=400) responses does not count against the budget', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const user = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__ratelimit-test__ transcribe skip-failed', systemRole: 'STAFF' },
  });

  try {
    const token = await sessionFor(user.id);
    const app = buildFailingLimiterTestApp(transcribeRateLimiter, 503);

    await withServer(app, async (baseUrl) => {
      // 25 failing requests — more than the 20-request allowance would ever
      // permit if failures counted. Every single one must still get through
      // to the (failing) handler rather than being 429'd, proving failures
      // are excluded from the counter — this route's only real failure mode
      // is a genuine provider outage (a 503), which shouldn't burn a
      // retrying user's budget.
      for (let i = 0; i < 25; i++) {
        const res = await post(baseUrl, token);
        assert.equal(res.status, 503, `request #${i + 1} should reach the handler and get its simulated 503, not a 429`);
      }
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test('rosterUploadRateLimiter: skipFailedRequests is false — failed (>=400) responses DO count against the budget', async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(location, 'seed data (location) must exist to run this test');

  const user = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__ratelimit-test__ roster-upload skip-failed', systemRole: 'MANAGER' },
  });

  try {
    const token = await sessionFor(user.id);
    // Simulates the real route's 422 (VisionIngestionError/PdfRasterizeError)
    // — a failure that still means a real, paid Gemini/Ollama call already
    // ran. Unlike voice.ts's routes, these must count, or repeated bad
    // uploads could dodge the limit while still spending real provider cost.
    const app = buildFailingLimiterTestApp(rosterUploadRateLimiter, 422);

    await withServer(app, async (baseUrl) => {
      for (let i = 0; i < 10; i++) {
        const res = await post(baseUrl, token);
        assert.equal(res.status, 422, `request #${i + 1} should reach the handler and get its simulated 422`);
      }
      // The 11th failing request must now be rate limited — proving the
      // prior 10 failures were counted, not skipped.
      const limited = await post(baseUrl, token);
      assert.equal(limited.status, 429, 'the 11th request must be rate limited even though every prior request "failed"');
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test('requireSession still runs first: an unauthenticated request to a rate-limited route gets 401, not counted against any user', async () => {
  const app = buildLimiterTestApp(transcribeRateLimiter);

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/test/limited`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 401, 'requireSession must reject before the limiter ever runs its keyGenerator (which requires req.user)');
  });
});
