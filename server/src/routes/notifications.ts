/**
 * Read-model for in-app notification history (server/src/lib/push.ts's
 * notifyUser writes the rows this serves). Generic — not Floor-Plan-
 * specific — any feature that calls notifyUser shows up here.
 */
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';

export const notificationsRouter = Router();

/** GET /api/notifications — the caller's own notifications, newest first. */
notificationsRouter.get('/', requireSession, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.status(200).json({
      notifications: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        url: n.url,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[notifications.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading notifications.' });
  }
});

/**
 * PATCH /api/notifications/:id/read — scoped to the caller's own row so
 * knowing someone else's notification id can't mark their notification
 * read. Idempotent: already-read is a silent no-op, not an error.
 */
notificationsRouter.patch('/:id/read', requireSession, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.notification.findFirst({ where: { id, userId: req.user!.id } });
    if (!existing) return res.status(404).json({ error: `Notification "${id}" not found.` });
    if (!existing.readAt) {
      await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    }
    return res.status(204).send();
  } catch (err) {
    console.error('[notifications.markRead] failed', err);
    return res.status(500).json({ error: 'Unexpected error while marking the notification read.' });
  }
});

/** POST /api/notifications/read-all — marks every unread notification for the caller read. */
notificationsRouter.post('/read-all', requireSession, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, readAt: null },
      data: { readAt: new Date() },
    });
    return res.status(204).send();
  } catch (err) {
    console.error('[notifications.markAllRead] failed', err);
    return res.status(500).json({ error: 'Unexpected error while marking notifications read.' });
  }
});
