/**
 * Generic Web Push (VAPID) delivery — not tied to any one feature. Floor
 * Plan's "Publish & notify" is the first caller, but any future feature
 * that needs to reach a user's device calls sendPushToUser(s) the same way.
 */
import webpush from 'web-push';
import { prisma } from './prisma.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:ops@example.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  // Fail soft, not silent: a misconfigured deploy still boots (push is an
  // enhancement, not a hard dependency), but every send attempt logs why
  // nothing went out instead of pretending to succeed.
  console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.');
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Client-side path to focus/open on notification click, e.g. "/scheduling". Defaults to "/" in the service worker if omitted. */
  url?: string;
}

/**
 * Sends one push notification to every device/browser a user has
 * subscribed (a user can have several). A subscription the push service
 * reports as gone (404/410 — uninstalled, permission revoked, expired) is
 * deleted here rather than left to fail forever on every future send.
 * Any other failure is logged, not thrown — one bad subscription, or one
 * user with none, must not block delivery to anyone else in a batch call.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; removed: number }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, removed: 0 };

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
        sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          removed += 1;
        } else {
          console.error('[push.send] failed for subscription', sub.id, err);
        }
      }
    }),
  );

  return { sent, removed };
}

/** Same as sendPushToUser, for several users at once (e.g. every staff member affected by one publish action). */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<{ sent: number; removed: number }> {
  const results = await Promise.all(userIds.map((id) => sendPushToUser(id, payload)));
  return results.reduce(
    (acc, r) => ({ sent: acc.sent + r.sent, removed: acc.removed + r.removed }),
    { sent: 0, removed: 0 },
  );
}

/**
 * The one function features should actually call: records the notification
 * in-app (so it shows up in the notification bell / history even on a
 * device with push off or unsupported) AND attempts real push delivery.
 * Never throws — a push failure must not roll back or hide the in-app
 * record, and a caller notifying several people in a loop must not have
 * one failure block the rest.
 */
export async function notifyUser(userId: string, payload: PushPayload): Promise<void> {
  try {
    await prisma.notification.create({
      data: { userId, title: payload.title, body: payload.body, url: payload.url },
    });
  } catch (err) {
    console.error('[push.notifyUser] failed to record notification', userId, err);
  }
  await sendPushToUser(userId, payload);
}

/**
 * Same delivery as notifyUser, for a full-roster broadcast (e.g. an
 * announcement) rather than a small, already-known-affected set. Every
 * digest notification elsewhere in this codebase fires its (small) list of
 * recipients as one concurrent batch, which is fine at that scale — a
 * whole-location fan-out can be large enough that doing the same thing
 * naively opens one DB connection per recipient at once, and this project's
 * shared dev Postgres pool has a real, previously-observed cap (~15
 * concurrent connections) that a large-enough roster could exhaust,
 * starving unrelated concurrent requests. Processes recipients in small
 * sequential batches instead of one giant Promise.all — no new
 * infrastructure (no queue/worker), just a bounded concurrency loop.
 */
export async function notifyUsersBatched(userIds: string[], payload: PushPayload, batchSize = 5): Promise<void> {
  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize);
    await Promise.all(batch.map((userId) => notifyUser(userId, payload)));
  }
}
