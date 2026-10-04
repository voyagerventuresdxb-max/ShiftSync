import type { CorsOptions } from 'cors';

/**
 * `CORS_ORIGINS` (comma-separated) limits which browser origins may call this
 * API cross-origin, e.g. the Capacitor Android shell at `https://localhost`.
 * Unset or empty keeps `cors()`'s default of any origin, exactly as before it
 * existed. The web app never needs to be listed: it reaches the API
 * same-origin through Vercel's `/api` rewrite (or Vite's dev proxy).
 */
export function corsOptionsFromEnv(raw: string | undefined = process.env.CORS_ORIGINS): CorsOptions | undefined {
  const origins = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return origins.length ? { origin: origins } : undefined;
}
