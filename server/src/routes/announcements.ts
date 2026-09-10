import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { notifyUsersBatched } from '../lib/push.js';

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

/** POST /api/announcements — body: { locationId, authorId?, body } */
announcementsRouter.post('/', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const authorId = req.body?.authorId ? String(req.body.authorId).trim() : null;
    const body = String(req.body?.body ?? '').trim();
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!body) return res.status(400).json({ error: 'body is required.' });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    // authorId is optional, but when supplied it carries an FK constraint —
    // validate it here so a non-User id (e.g. the client's synthetic
    // `upload-emp-<name>` fallback) gets a clear 404 rather than an opaque 500
    // from the raw FK violation.
    if (authorId) {
      const author = await prisma.user.findUnique({ where: { id: authorId } });
      if (!author) return res.status(404).json({ error: `Author "${authorId}" not found.` });
    }

    const created = await prisma.announcement.create({
      data: { locationId, authorId, body },
      include: { author: { select: { fullName: true } } },
    });

    // Real delivery on top of the write above (never blocking the
    // response). Every active staff member at the location, immediate, one
    // per post — not digested, unlike the affected-set notifications
    // elsewhere, since each announcement is its own deliberate broadcast.
    // The poster themselves is excluded — they don't need telling about
    // their own post. Batched (notifyUsersBatched, not one big Promise.all)
    // since this is the one full-roster fan-out in the app, not a small
    // known-affected set.
    const recipients = await prisma.user.findMany({
      where: { locationId, isActive: true, id: { not: authorId ?? undefined } },
      select: { id: true },
    });
    void notifyUsersBatched(
      recipients.map((r) => r.id),
      { title: 'New announcement', body, url: '/' },
    );

    return res.status(201).json({
      announcement: {
        id: created.id,
        body: created.body,
        authorId: created.authorId,
        authorName: created.author?.fullName ?? null,
        createdAt: created.createdAt.toISOString(),
        editedAt: null,
      },
    });
  } catch (err) {
    console.error('[announcements.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while posting the announcement.' });
  }
});

/** PATCH /api/announcements/:id — body: { body } */
announcementsRouter.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'body is required.' });

    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Announcement "${id}" not found.` });

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

/** DELETE /api/announcements/:id */
announcementsRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Announcement "${id}" not found.` });
    await prisma.announcement.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    console.error('[announcements.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the announcement.' });
  }
});
