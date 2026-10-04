/**
 * The one `fetch` every API module goes through.
 *
 * It exists for a single cross-cutting rule: when a request that carried a
 * session token comes back 401, the session is dead (expired, revoked on
 * sign-out elsewhere, or the account was deactivated) and the whole app must
 * react the same way, not just the one screen that happened to make the call.
 * `onSessionRejected` subscribers (see `SessionGuard` in router.tsx) clear
 * local state and send the person to `/login` with a plain message.
 *
 * Only AUTHENTICATED requests count: a 401 from `verify-otp` ("Incorrect
 * code.") is a normal form error, not a dead session, and those requests
 * carry no `Authorization` header.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onSessionRejected(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function hasAuthorization(init?: RequestInit): boolean {
  const headers = init?.headers;
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has('Authorization');
  if (Array.isArray(headers)) return headers.some(([name]) => name.toLowerCase() === 'authorization');
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
}

/** Pure, so it can be unit-tested: does this response mean "the session is dead"? */
export function isSessionRejection(status: number, init?: RequestInit): boolean {
  return status === 401 && hasAuthorization(init);
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (isSessionRejection(res.status, init)) {
    for (const listener of listeners) listener();
  }
  return res;
}

/** `Retry-After` as whole seconds, or null when absent/unusable (HTTP-date values are not used by this API). */
export function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}
