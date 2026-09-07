/**
 * Web Push orchestration: service worker registration (safe to call
 * unconditionally — it never prompts the user for anything) and the
 * actual subscribe/unsubscribe flow (which DOES trigger the browser's
 * permission prompt, so it must only ever be called from an explicit,
 * user-initiated action — see SafetyValve/StaffDirectory-style opt-in UI,
 * never automatically on page load).
 */
import { fetchVapidPublicKey, subscribePush, unsubscribePush, ApiError } from '../api/push';

export function isPushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

/**
 * Registers the service worker if the browser supports it. Idempotent —
 * calling this again (e.g. on every app load) just resolves to the
 * existing registration. Never touches Notification permission.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.error('[push] service worker registration failed', err);
    return null;
  }
}

/** 'unsupported' | Notification.permission ('default' | 'granted' | 'denied'). */
export function getPushPermissionState(): NotificationPermission | 'unsupported' {
  if (!isPushSupported() || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** The endpoint of the current push subscription for this browser, if any — for UI to show "already enabled" instead of re-prompting. */
export async function getExistingSubscriptionEndpoint(): Promise<string | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}

// Standard VAPID-key conversion: the browser's PushManager.subscribe()
// wants the public key as a Uint8Array, but the server hands it over
// base64url-encoded text.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

export type SubscribeResult = { ok: true } | { ok: false; reason: 'unsupported' | 'denied' | 'error'; message?: string };

/**
 * The one place that actually triggers the browser's permission prompt —
 * call this ONLY from a click handler on an explicit "Enable notifications"
 * action, never on mount/page load (auto-prompting on load is exactly the
 * pattern that gets a site's notifications auto-blocked by the browser).
 */
export async function subscribeToPush(token: string): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  try {
    const registration = (await navigator.serviceWorker.getRegistration('/sw.js')) ?? (await registerServiceWorker());
    if (!registration) return { ok: false, reason: 'unsupported' };

    const publicKey = await fetchVapidPublicKey();
    if (!publicKey) return { ok: false, reason: 'error', message: 'Push is not configured for this venue yet.' };

    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // TS's lib.dom BufferSource type wants an ArrayBuffer-backed view
        // specifically; Uint8Array is a valid BufferSource at runtime
        // regardless — this is a known TS/DOM-lib typing mismatch, not a
        // real type error.
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, reason: 'error', message: 'Could not read the new subscription.' };
    }
    await subscribePush(token, { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof ApiError ? err.message : 'Could not enable push notifications.' };
  }
}

/** Reverses subscribeToPush: unsubscribes this browser and tells the server to forget it. */
export async function unsubscribeFromPush(token: string): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => {});
  await unsubscribePush(token, endpoint).catch(() => {
    // The browser-side unsubscribe already happened; a failed server-side
    // cleanup just leaves a dead row that sendPushToUser prunes on its own
    // next failed delivery attempt — not worth blocking the UI on.
  });
}
