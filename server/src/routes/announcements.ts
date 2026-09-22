import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession, ownedOrNotFound } from '../middleware/requireSession.js';
import { createAnnouncement } from '../lib/actions/communicationActions.js';

export const announcementsRouter = Router();

/**
 * GET /api/announcements/:locationId — newest first.
 * Deliberately NOT behind `requireSession` — this is the kiosk-access-fork
 * decision (Option 3, 2026-08-31 — see MEMORY.md): `/` (Home) stays
 * anonymous-friendly for the "walk up to the shared venue device" use case,
 * and Announcements is one of the two read surfaces (with Shoutouts) that
 * decision explicitly restores anonymous access to. Confirmed still correct
 * by the follow-up anonymous-read sweep, not newly decided here.
 */
announcementsRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const rows = await prisma.announcement.findMany({
      where: { locationId },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { fullName: true } } },
    });
    return res.status(200).json({
      announcements: rows.map((a) => ({
        id: a.id,
        body: a.body,
        authorId: a.authorId,
        authorName: a.author?.fullName ?? null,
        createdAt: a.createdAt.toISOString(),
        editedAt: a.editedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    console.error('[announcements.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading announcements.' });
  }
});

/**
 * POST /api/announcements — body: { authorId?, body }.
 * `requireSession`-gated (spec 2026-09-11-voice-post-announcement-shoutout-design.md
 * §2.3a) — this route previously required no authentication at all, so
 * anyone could broadcast an announcement to a venue attributed to an
 * arbitrary authorId. This is an authentication fix only, not a role
 * restriction: any signed-in user, same audience as before this fix, can
 * still post — only anonymous access is closed.
 *
 * `locationId` comes from the caller's own session, not the request body
 * (2026-09-20 tenant-isolation fix — the earlier `req.body.locationId` was
 * only checked for existence, not ownership, so any signed-in user at any
 * venue could post into a different venue's feed by naming its locationId;
 * same fix shape as `shifts.ts`'s POST /, which already sources `locationId`
 * from the session for the same reason).
 */
announcementsRouter.post('/', requireSession, async (req, res) => {
  try {
    const locationId = req.user!.locationId;
    // The author is whoever is signed in — never a body-supplied id. The
    // client used to send its "Viewing" employee (or nothing at all for a
    // fresh venue), so announcements were attributed to a colleague, or to
    // nobody — and an author-less announcement then rendered under the
    // VIEWER's own name on their My Shifts screen.
    const authorId = req.user!.id;
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'body is required.' });

    const result = await createAnnouncement({ locationId, authorId, body });
    if (result.result !== 'ok') {
      const status = result.result === 'rate_limited' ? 429 : result.result === 'too_long' ? 400 : 404;
      return res.status(status).json({ error: result.message });
    }
    return res.status(201).json({
      announcement: {
        id: result.announcement.id,
        body: result.announcement.body,
        authorId: result.announcement.authorId,
        authorName: result.announcement.authorName,
        createdAt: result.announcement.createdAt.toISOString(),
        editedAt: null,
      },
    });
  } catch (err) {
    console.error('[announcements.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while posting the announcement.' });
  }
});

/**
 * PATCH /api/announcements/:id — body: { body }.
 * `requireSession`-gated, scoped to the caller's own venue via
 * `ownedOrNotFound` (2026-09-20 tenant-isolation fix — this route previously
 * had no auth middleware and no ownership check at all: anyone, signed in or
 * not, who had or guessed an announcement id could edit any venue's
 * announcement).
 */
announcementsRouter.patch('/:id', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'body is required.' });

    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Announcement "${id}" not found.`)) return;

    const updated = await prisma.announcement.update({
      where: { id },
      data: { body, editedAt: new Date() },
      include: { author: { select: { fullName: true } } },
    });
    return res.status(200).json({
      announcement: {
        id: updated.id,
        body: updated.body,
        authorId: updated.authorId,
        authorName: updated.author?.fullName ?? null,
        createdAt: updated.createdAt.toISOString(),
        editedAt: updated.editedAt!.toISOString(),
      },
    });
  } catch (err) {
    console.error('[announcements.update] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the announcement.' });
  }
});

/**
 * DELETE /api/announcements/:id
 * `requireSession`-gated, scoped to the caller's own venue via
 * `ownedOrNotFound` — same 2026-09-20 tenant-isolation fix as PATCH, above:
 * this route had no auth middleware and no ownership check at all before.
 */
announcementsRouter.delete('/:id', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!ownedOrNotFound(req, res, existing, `Announcement "${id}" not found.`)) return;
    await prisma.announcement.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    console.error('[announcements.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the announcement.' });
  }
});
