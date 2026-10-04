/**
 * Generic Web Push (VAPID) delivery — not tied to any one feature. Floor
 * Plan's "Publish & notify" is the first caller, but any future feature
 * that needs to reach a user's device calls sendPushToUser(s) the same way.
 */
import { createECDH } from 'node:crypto';
import webpush from 'web-push';
import { prisma } from './prisma.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:ops@example.com';

/**
 * Dev/e2e seam: PUSH_TRANSPORT=record replaces delivery with an in-memory outbox (read at
 * GET /api/dev/push-outbox), so push flows are testable end to end with no VAPID keys, push
 * service or push sink — "mocked at the boundary": everything up to the send is the real code.
 * The browser side stays as with push off (no public key is served). Refused in production
 * (productionGuards.ts).
 */
const RECORD_PUSH = (process.env.PUSH_TRANSPORT ?? '').trim() === 'record';
export interface RecordedPush {
  userId: string;
  endpoint: string;
  payload: PushPayload;
  at: string;
}
const outbox: RecordedPush[] = [];
const OUTBOX_LIMIT = 500;

/** The recorded sends (PUSH_TRANSPORT=record only), oldest first. */
export function pushOutbox(): readonly RecordedPush[] {
  return outbox;
}

export function isPushRecording(): boolean {
  return RECORD_PUSH;
}

let pushEnabled = false;
if (RECORD_PUSH) {
  console.warn('[push] PUSH_TRANSPORT=record — sends are recorded in memory, not delivered (dev/e2e only).');
} else if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    // Halves of two different pairs pass web-push's format checks, but every push service rejects the signature.
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(VAPID_PRIVATE_KEY, 'base64url'));
    if (ecdh.getPublicKey().toString('base64url') !== VAPID_PUBLIC_KEY) {
      throw new Error('VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY');
    }
    pushEnabled = true;
  } catch (err) {
    // A typo in a deploy variable must not crash-loop the API. web-push echoes a bad subject verbatim, and that
    // variable may hold a mis-pasted private key, so the subject's value never reaches the log.
    const reason = err instanceof Error ? err.message : String(err);
    const safeReason = VAPID_SUBJECT ? reason.split(VAPID_SUBJECT).join('<VAPID_SUBJECT>') : reason;
    console.error(`[push] VAPID config rejected (${safeReason}) — push notifications are disabled.`);
  }
} else {
  // Fail soft, not silent: a misconfigured deploy still boots (push is an
  // enhancement, not a hard dependency), but every send attempt logs why
  // nothing went out instead of pretending to succeed.
  console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.');
}

export function getVapidPublicKey(): string {
  return pushEnabled ? VAPID_PUBLIC_KEY : '';
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
  if (!pushEnabled && !RECORD_PUSH) return { sent: 0, removed: 0 };

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (RECORD_PUSH) {
    for (const sub of subscriptions) {
      outbox.push({ userId, endpoint: sub.endpoint, payload, at: new Date().toISOString() });
      if (outbox.length > OUTBOX_LIMIT) outbox.shift();
    }
    return { sent: subscriptions.length, removed: 0 };
  }
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
  try {
    await sendPushToUser(userId, payload);
  } catch (err) {
    console.error('[push.notifyUser] push delivery failed', userId, err);
  }
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
