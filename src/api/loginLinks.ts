/**
 * Client for one-time login links (server/src/routes/loginLinks.ts).
 * `peek` is read-only; `redeem` is the ONLY call that spends a link and is
 * made from the Sign in tap and nowhere else (see routes/LoginLinkRoute.tsx).
 */
import { ApiError } from './schedules';
import { withAuth, type SessionUser } from './identity';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let errorCode: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; errorCode?: string };
      if (body?.error) message = body.error;
      errorCode = body?.errorCode;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new LoginLinkApiError(message, res.status, errorCode);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class LoginLinkApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    public readonly errorCode?: string,
  ) {
    super(message, status);
    this.name = 'LoginLinkApiError';
  }
}

export interface IssuedLoginLink {
  id: string;
  url: string;
  expiresAt: string;
  shareText: string;
}

/** POST /api/login-links — manager/owner/platform admin only; the server decides scope. */
export async function issueLoginLink(token: string, userId: string): Promise<IssuedLoginLink> {
  return request('/api/login-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ userId }),
  });
}

/** DELETE /api/login-links/:id */
export async function revokeLoginLink(token: string, id: string): Promise<void> {
  await request<void>(`/api/login-links/${encodeURIComponent(id)}`, { method: 'DELETE', headers: withAuth(token) });
}

export interface LoginLinkPreview {
  fullName: string;
  venueName: string;
  expiresAt: string;
}

/** POST /api/login-links/peek — read-only. */
export async function peekLoginLink(linkToken: string): Promise<LoginLinkPreview> {
  return request('/api/login-links/peek', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: linkToken }),
  });
}

/** POST /api/login-links/redeem — spends the link. Call from the Sign in tap only. */
export async function redeemLoginLink(linkToken: string): Promise<{ token: string; expiresAt: string; user: SessionUser; landing: string }> {
  return request('/api/login-links/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: linkToken }),
  });
}

export type LoginMethods = 'links' | 'otp';

let configPromise: Promise<{ loginMethods: LoginMethods }> | null = null;

/** GET /api/identity/config — cached for the page's lifetime; falls back to links-only if the server can't be reached. */
export function getLoginConfig(): Promise<{ loginMethods: LoginMethods }> {
  if (!configPromise) {
    configPromise = request<{ loginMethods: LoginMethods }>('/api/identity/config').catch(() => {
      configPromise = null;
      return { loginMethods: 'links' as const };
    });
  }
  return configPromise;
}
