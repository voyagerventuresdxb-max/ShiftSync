import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, requireManager, ownedOrNotFound } from '../middleware/requireSession.js';
import { notifyUser } from '../lib/push.js';
import type { FloorFeedbackStatus } from '@prisma/client';

export const floorFeedbackRouter = Router();

/**
 * Shared DTO shape for the manager-facing list/decide responses.
 * `userId` (the real submitter) is deliberately never part of this — it is
 * never selected out of Prisma in the first place (see the `select` blocks
 * below), not merely stripped here, so the real submitter can't leak through
 * this endpoint by omission at a single call site being forgotten later.
 */
function toDto(r: {
  id: string;
  content: string;
  status: FloorFeedbackStatus;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: { fullName: string } | null;
}) {
  return {
    id: r.id,
    content: r.content,
    status: r.status.toLowerCase() as 'open' | 'flagged' | 'reviewed',
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewedByName: r.reviewedBy?.fullName ?? null,
  };
}

const FEEDBACK_SELECT = {
  id: true,
  content: true,
  status: true,
  createdAt: true,
  reviewedAt: true,
  reviewedBy: { select: { fullName: true } },
  // userId intentionally NOT selected — see toDto's comment above.
} as const;

/**
 * POST /api/floor-feedback — body: { content }
 * Any authenticated staff member. The submitter is always the caller's own
 * session id, never read from the body, and never echoed back in the
 * response — this is anonymous-to-management, so nothing here should let
 * the client associate a submission with its author beyond what the
 * browser already knows from having just typed it.
 */
floorFeedbackRouter.post('/', requireSession, async (req, res) => {
  try {
    const content = String(req.body?.content ?? '').trim();
    if (!content) return res.status(400).json({ error: 'content is required.' });

    await prisma.floorFeedback.create({
      data: {
        locationId: req.user!.locationId,
        userId: req.user!.id,
        content,
      },
    });
    return res.status(201).json({ message: 'Feedback submitted.' });
  } catch (err) {
    console.error('[floorFeedback.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while submitting feedback.' });
  }
});

/**
 * GET /api/floor-feedback?status=open|flagged|reviewed — manager-only.
 * Always scoped to the caller's own location, derived from the session —
 * unlike some other list routes there is no locationId URL param to
 * validate, since there's nothing client-supplied to check ownership of.
 */
floorFeedbackRouter.get('/', requireSession, requireManager, async (req, res) => {
  try {
    const statusParam = String(req.query.status ?? '').toUpperCase();
    if (statusParam && statusParam !== 'OPEN' && statusParam !== 'FLAGGED' && statusParam !== 'REVIEWED') {
      return res.status(400).json({ error: 'status must be "open", "flagged", or "reviewed".' });
    }

    const rows = await prisma.floorFeedback.findMany({
      where: {
        locationId: req.user!.locationId,
        ...(statusParam ? { status: statusParam as FloorFeedbackStatus } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: FEEDBACK_SELECT,
    });

    return res.status(200).json({ feedback: rows.map(toDto) });
  } catch (err) {
    console.error('[floorFeedback.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading floor feedback.' });
  }
});

/**
 * PATCH /api/floor-feedback/:id — body: { status: 'flagged' | 'reviewed' }
 * Manager-only. `flagged` = needs follow-up, `reviewed` = closed, no action
 * needed. Allowed transitions: open->flagged, open->reviewed, flagged->
 * reviewed. `reviewed` is terminal — mirrors JoinRequest's "already
 * reviewed" 409 pattern, since re-deciding a closed item has no meaning.
 */
floorFeedbackRouter.patch('/:id', requireSession, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body?.status ?? '');
    if (status !== 'flagged' && status !== 'reviewed') {
      return res.status(400).json({ error: 'status must be "flagged" or "reviewed".' });
    }

    const existing = await prisma.floorFeedback.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Floor feedback "${id}" not found.`)) return;
    if (existing.status === 'REVIEWED') {
      return res.status(409).json({ error: 'This feedback has already been reviewed.' });
    }

    const updated = await prisma.floorFeedback.update({
      where: { id },
      data: {
        status: status.toUpperCase() as FloorFeedbackStatus,
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
      },
      select: FEEDBACK_SELECT,
    });

    // Real delivery to the original submitter, using `existing.userId` —
    // fetched above via a plain findUnique with no `select`, so it was
    // already in hand server-side; it is NOT added to FEEDBACK_SELECT or
    // any manager-facing query/response, and this stays the only place that
    // reads it. Copy is deliberately generic for BOTH 'flagged' and
    // 'reviewed' outcomes: no feedback content, no reviewer identity, and
    // no distinction between the two statuses, since even that could hint
    // at how a manager reacted. No audit log entry is written for this —
    // this route has never audited its actions (unlike most mutation routes
    // in this codebase), and this must not be the first side effect that
    // changes that.
    void notifyUser(existing.userId, {
      title: 'Feedback update',
      body: 'Your feedback has been reviewed.',
      url: '/',
    });

    return res.status(200).json({ feedback: toDto(updated) });
  } catch (err) {
    console.error('[floorFeedback.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while updating floor feedback.' });
  }
});
