import { devOtpEchoEnabled, echoAllowedPhones } from './devOtpEcho.js';

/** Flags that must never be on in production — a login bypass and a deliberate crash trigger. */
export const FORBIDDEN_IN_PRODUCTION = ['ALLOW_DEV_OTP_BYPASS', 'ALLOW_DEV_ERROR_INJECTION'] as const;

/**
 * NODE_ENV=production, or Railway's own environment name: this repo's start
 * command never sets NODE_ENV, and a guard that silently skips the live deploy is worse than none.
 */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.RAILWAY_ENVIRONMENT_NAME === 'production';
}

export function isFlagOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[name] === 'true';
}

/**
 * Throws (so `index.ts` exits non-zero before `listen`) when production is
 * configured unsafely, naming every offending setting at once. Returns the
 * non-fatal warnings for the caller to log.
 */
export function checkProductionEnv(env: NodeJS.ProcessEnv = process.env): { warnings: string[] } {
  const { phones, invalid } = echoAllowedPhones(env);
  const warnings = invalid.map((entry) => `ECHO_ALLOWED_PHONES entry "${entry}" is not a valid mobile number — ignored.`);
  const echoWithoutAllowlist = devOtpEchoEnabled(env) && phones.size === 0;

  if (!isProduction(env)) {
    if (echoWithoutAllowlist) warnings.push('ALLOW_DEV_OTP_ECHO=true but ECHO_ALLOWED_PHONES has no valid number — no code will be echoed.');
    return { warnings };
  }

  const fatal: string[] = [];
  if (echoWithoutAllowlist) {
    fatal.push('ALLOW_DEV_OTP_ECHO=true needs at least one valid mobile number in ECHO_ALLOWED_PHONES (comma-separated).');
  }
  for (const flag of FORBIDDEN_IN_PRODUCTION) {
    if (!isFlagOn(flag, env)) continue;
    fatal.push(
      flag === 'ALLOW_DEV_OTP_BYPASS'
        ? `${flag}=true makes the fixed code 000000 log in as ANY phone number.`
        : `${flag}=true lets a sentinel bearer token crash session auth on demand.`,
    );
  }
  if (fatal.length > 0) {
    throw new Error(
      `Refusing to start in production (NODE_ENV=${env.NODE_ENV ?? '<unset>'}, RAILWAY_ENVIRONMENT_NAME=${env.RAILWAY_ENVIRONMENT_NAME ?? '<unset>'}):\n` +
        `${fatal.map((line) => `  - ${line}`).join('\n')}\nSee docs/deployment.md.`,
    );
  }
  return { warnings };
}
