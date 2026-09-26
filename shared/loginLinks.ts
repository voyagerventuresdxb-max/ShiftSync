/**
 * Shared between the server (which mints links) and the client (which
 * accepts a pasted one). The token rides in the URL FRAGMENT so it never
 * reaches server access logs, proxies, or a chat app's link-preview fetch.
 */
export const LOGIN_LINK_PATH = '/login/link';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Pulls the token out of whatever a person pasted: a full link
 * (`https://app/login/link#TOKEN`), just the fragment, or the bare token.
 * Returns null when nothing token-shaped is there.
 */
export function extractLoginLinkToken(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const hashIndex = raw.indexOf('#');
  const candidate = (hashIndex >= 0 ? raw.slice(hashIndex + 1) : raw).split(/[?&\s]/)[0]!.trim();
  return TOKEN_RE.test(candidate) ? candidate : null;
}
