/**
 * `returnTo` arrives via a URL query param (`RequireSession` in `router.tsx`
 * sets it, `/login` reads it) — that means it's untrusted, attacker-craftable
 * input: anyone can send someone a link like
 * `/login?returnTo=https://evil.example` hoping the post-login redirect
 * carries their target somewhere off this app.
 *
 * An earlier draft tried to reject unsafe values with a blocklist (no `//`,
 * no backslash, no `://`) — a real-world review caught that this class of
 * check is fundamentally fragile: the WHATWG URL parser strips ASCII
 * tab/CR/LF from a URL before resolving it, so `/\t/evil.example` (no `//`,
 * no backslash, no `://` — passes every blocklist check as a raw string)
 * still normalizes to `//evil.example` — a protocol-relative redirect to
 * another host — the instant it's assigned to `window.location.href`.
 * Verified: `new URL('/\t/evil.example', 'https://x').host` really is
 * `'evil.example'`. A blocklist can always miss the next normalization
 * quirk; asking "what will the browser's own URL parser actually resolve
 * this to" instead can't be bypassed by a parsing quirk, because it uses
 * the exact same parser that will process the string at navigation time.
 * `https://internal.invalid` is an arbitrary fixed base with no real
 * meaning — it exists only so `new URL(path, base)` can resolve a relative
 * path the same way the browser will, without depending on `window` (this
 * stays a plain, Node-testable function). If resolving `path` against that
 * base yields a DIFFERENT origin, `path` was never a same-origin relative
 * path to begin with — no matter what tricks were used to write it.
 *
 * `/join` and `/login` are rejected so a sign-in can't bounce back into a
 * sign-in screen. Case-INSENSITIVE on purpose: react-router-dom's route
 * matching defaults to caseSensitive: false (this app's routes set no
 * override), so `/JOIN` or `/Login` really do route back into those screens.
 */
export function isSafeReturnTo(path: string | undefined | null): path is string {
  // Router-relative values (`scheduling`, `?x`) would resolve against /login itself.
  if (!path || !path.startsWith('/')) return false;
  const base = 'https://internal.invalid';
  try {
    const url = new URL(path, base);
    if (url.origin !== base) return false;
    // Decoded because react-router decodes before matching: `/%6Cogin` routes to /login.
    const pathname = decodeURIComponent(url.pathname).toLowerCase();
    return !pathname.startsWith('/join') && !pathname.startsWith('/login');
  } catch {
    return false;
  }
}

/**
 * Where a freshly signed-in session goes: a safe `returnTo` wins, otherwise
 * a confirmed MANAGER/OWNER lands on `/` and anything else on `/my-shifts`.
 * Positive check, like `RequireSession`: an unexpected role string fails
 * closed to the staff landing, never onto a manager page.
 */
export function postLoginDestination(systemRole: string | undefined, returnTo?: string | null): string {
  if (isSafeReturnTo(returnTo)) return returnTo;
  return systemRole === 'OWNER' || systemRole === 'MANAGER' ? '/' : '/my-shifts';
}
