/**
 * Boot-time safety net for the dev-only environment flags. Every flag here
 * is fail-closed and opt-in (see the comments beside each in the routes),
 * which protects against them being on by accident locally — but nothing
 * used to stop a deploy that copied a local `.env` wholesale, and
 * `docs/deployment.md` once told the operator to turn ALLOW_DEV_OTP_ECHO on
 * for a demo. This is the other half: in production, the two flags that
 * hand out authentication for free refuse to boot, the echo flag shouts, and
 * the CORS allowlist must be configured explicitly.
 *
 * "Production" means `NODE_ENV=production`, exactly. Nothing in this repo
 * sets it — the deploy host must (see docs/deployment.md, "Required in
 * production"). That is deliberate: the flags stay opt-in either way, so a
 * missing NODE_ENV never *enables* anything; it only skips this refusal.
 */

/** Flags that must never be on in production — each one is a login bypass or a deliberate crash trigger. */
export const FORBIDDEN_IN_PRODUCTION = ['ALLOW_DEV_OTP_BYPASS', 'ALLOW_DEV_ERROR_INJECTION'] as const;

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function isFlagOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[name] === 'true';
}

/**
 * Throws (so `index.ts` exits non-zero before `listen`) when the process is
 * in production with a forbidden flag on, or without FRONTEND_ORIGIN. The
 * message names every offending setting at once so one redeploy fixes all
 * of them. Returns the warnings that do NOT block boot (currently only the
 * OTP echo) so the caller can log them loudly.
 */
export function checkProductionEnv(env: NodeJS.ProcessEnv = process.env): { warnings: string[] } {
  if (!isProduction(env)) return { warnings: [] };

  const fatal: string[] = [];
  for (const flag of FORBIDDEN_IN_PRODUCTION) {
    if (isFlagOn(flag, env)) {
      fatal.push(
        flag === 'ALLOW_DEV_OTP_BYPASS'
          ? `${flag}=true makes the fixed code 000000 log in as ANY phone number.`
          : `${flag}=true lets a sentinel bearer token crash session auth on demand.`,
      );
    }
  }
  if (!env.FRONTEND_ORIGIN?.trim()) {
    fatal.push('FRONTEND_ORIGIN is unset — CORS and invite links would fall back to http://localhost:5173.');
  }
  if (fatal.length > 0) {
    throw new Error(
      `Refusing to start with NODE_ENV=production:\n${fatal.map((line) => `  - ${line}`).join('\n')}\n` +
        'Unset the dev flags and set FRONTEND_ORIGIN (see docs/deployment.md).',
    );
  }

  const warnings: string[] = [];
  if (isFlagOn('ALLOW_DEV_OTP_ECHO', env)) {
    warnings.push(
      'ALLOW_DEV_OTP_ECHO=true in production: every one-time code is returned to whoever requested it, ' +
        'so anyone who knows a phone number can log in as that person. Turn it off.',
    );
  }
  return { warnings };
}
