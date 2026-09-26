const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:5173';

/**
 * Origins the server trusts as "the ShiftSync frontend": the CORS allowlist
 * (middleware/cors.ts) and the only origins an invite link is ever minted
 * against (routes/onboarding.ts). `FRONTEND_ORIGIN` is comma-separated for
 * multiple environments (staging + prod, or a custom domain alongside the
 * Vercel one); unset, only the local Vite dev origin is allowed. Read fresh
 * on every call (not memoized at module load) so it can be reconfigured —
 * e.g. per-test — without restarting the process.
 */
export function getAllowedFrontendOrigins(): string[] {
  const configured = process.env.FRONTEND_ORIGIN?.trim();
  if (!configured) return [DEFAULT_FRONTEND_ORIGIN];
  return configured
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
