/**
 * Every `/api/...` and `/uploads/...` request goes through here. On the web
 * `VITE_API_URL` is unset and paths stay relative (same origin, via Vercel's
 * rewrite or Vite's dev proxy). The Capacitor shell's origin is
 * https://localhost, so its build sets `VITE_API_URL` to the API's own origin.
 * `?.` because `import.meta.env` doesn't exist under the node test runner.
 */
const API_BASE = import.meta.env?.VITE_API_URL ?? '';

export function apiUrl(path: string, base: string = API_BASE): string {
  return base ? `${base.replace(/\/+$/, '')}${path}` : path;
}
