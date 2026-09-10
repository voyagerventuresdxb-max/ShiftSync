/** Client for the Web Push subscription API (server/src/routes/push.ts). */
import { ApiError } from './schedules';
import { withAuth } from './identity';

export { ApiError };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET /api/push/vapid-public-key — no auth required; the key is safe to hand to any client. */
export async function fetchVapidPublicKey(): Promise<string> {
  const data = await request<{ publicKey: string }>('/api/push/vapid-public-key');
  return data.publicKey;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** POST /api/push/subscribe */
export async function subscribePush(token: string, subscription: PushSubscriptionInput): Promise<void> {
  await request('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify(subscription),
  });
}

/** DELETE /api/push/subscribe */
export async function unsubscribePush(token: string, endpoint: string): Promise<void> {
  await request('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ endpoint }),
  });
}
