/**
 * Generic Web Push subscription lifecycle — register/unregister a device,
 * plus the public key the client needs to subscribe. Not Floor-Plan-
 * specific: any feature that sends push notifications reuses these same
 * subscriptions via server/src/lib/push.ts.
 */
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';
import { getVapidPublicKey } from '../lib/push.js';

export const pushRouter = Router();

/**
 * GET /api/push/vapid-public-key — the VAPID public key is, by design,
 * safe to hand to any client (it's how the push service verifies WE sent
 * the request, not a secret the client could misuse). Deliberately not
 * behind requireSession: a client needs it before it has anything to do
 * with a session, to even construct the subscribe() call.
 */
pushRouter.get('/vapid-public-key', (_req, res) => {
  return res.status(200).json({ publicKey: getVapidPublicKey() });
});

/**
 * POST /api/push/subscribe — body: { endpoint, keys: { p256dh, auth } }
 * (the shape of `PushSubscription.toJSON()` from the browser's own Push
 * API). Upserts by endpoint: a browser re-subscribing to the same
 * registration (e.g. after clearing and re-granting permission) updates
 * the existing row's owner/keys rather than accumulating duplicates.
 */
pushRouter.post('/subscribe', requireSession, async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint ?? '').trim();
    const p256dh = String(req.body?.keys?.p256dh ?? '').trim();
    const auth = String(req.body?.keys?.auth ?? '').trim();
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ error: 'endpoint and keys.p256dh/keys.auth are required.' });
    }
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.user!.id, p256dh, auth },
      create: { userId: req.user!.id, endpoint, p256dh, auth },
    });
    return res.status(201).json({ message: 'Subscribed.' });
  } catch (err) {
    console.error('[push.subscribe] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the subscription.' });
  }
});

/**
 * DELETE /api/push/subscribe — body: { endpoint }. Scoped to the caller's
 * own subscriptions (endpoint + userId), so knowing someone else's
 * endpoint can't remove their subscription. Idempotent: a missing row is a
 * silent no-op, same as sign-out's session revoke — "already unsubscribed"
 * must never be an error.
 */
pushRouter.delete('/subscribe', requireSession, async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint ?? '').trim();
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required.' });
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user!.id } });
    return res.status(204).send();
  } catch (err) {
    console.error('[push.unsubscribe] failed', err);
    return res.status(500).json({ error: 'Unexpected error while removing the subscription.' });
  }
});
