import { devOtpEchoEnabled, echoAllowedPhones } from './devOtpEcho.js';
import { missingSmsSettings, smsOtpEnabled } from './sms.js';

/**
 * Every variable that can redirect Gemini / Vertex traffic to another host:
 * our own dev/e2e seam (`GEMINI_BASE_URL`, read only by the voice clients)
 * and the two the `@google/genai` SDK itself honours for ANY client,
 * including roster vision. In production none may be set to anything: a
 * value here means audio, transcripts and roster images would leave for a
 * URL nobody reviewed. URL-shaped, so "any non-blank value" counts as on.
 */
export const GEMINI_BASE_URL_OVERRIDES = ['GEMINI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL'] as const;

export function isBaseUrlOverride(name: string): name is (typeof GEMINI_BASE_URL_OVERRIDES)[number] {
  return (GEMINI_BASE_URL_OVERRIDES as readonly string[]).includes(name);
}

/** The dev/e2e push seam (lib/push.ts): any value replaces real delivery with an in-memory outbox. */
export const PUSH_TRANSPORT = 'PUSH_TRANSPORT';

/** Settings that must never be on in production — a login bypass, a deliberate crash trigger, a redirect of voice AI traffic, and fake push delivery. */
export const FORBIDDEN_IN_PRODUCTION = ['ALLOW_DEV_OTP_BYPASS', 'ALLOW_DEV_ERROR_INJECTION', ...GEMINI_BASE_URL_OVERRIDES, PUSH_TRANSPORT] as const;

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
  // SMS on but unconfigured would fail every request-otp, i.e. every sign-in.
  const smsMissing = smsOtpEnabled(env) ? missingSmsSettings(env) : [];
  const smsIncomplete = smsMissing.length > 0 ? `SMS_OTP_ENABLED=true but ${smsMissing.join(', ')} is not set — every code request would fail.` : null;

  if (!isProduction(env)) {
    if (echoWithoutAllowlist) warnings.push('ALLOW_DEV_OTP_ECHO=true but ECHO_ALLOWED_PHONES has no valid number — no code will be echoed.');
    if (smsIncomplete) warnings.push(smsIncomplete);
    return { warnings };
  }

  const fatal: string[] = [];
  if (echoWithoutAllowlist) {
    fatal.push('ALLOW_DEV_OTP_ECHO=true needs at least one valid mobile number in ECHO_ALLOWED_PHONES (comma-separated).');
  }
  if (smsIncomplete) fatal.push(smsIncomplete);
  for (const flag of FORBIDDEN_IN_PRODUCTION) {
    // The base-URL overrides and the push transport are values, not boolean flags: any value at all is on.
    if (isBaseUrlOverride(flag) || flag === PUSH_TRANSPORT ? !env[flag]?.trim() : !isFlagOn(flag, env)) continue;
    fatal.push(
      flag === 'ALLOW_DEV_OTP_BYPASS'
        ? `${flag}=true makes the fixed code 000000 log in as ANY phone number.`
        : flag === 'ALLOW_DEV_ERROR_INJECTION'
          ? `${flag}=true lets a sentinel bearer token crash session auth on demand.`
          : flag === PUSH_TRANSPORT
            ? `${flag} is set — push notifications would be recorded in memory instead of delivered (a dev/e2e seam).`
            : `${flag} is set — Gemini/Vertex traffic (voice audio, transcripts, roster images) would go to that URL instead of Google.`,
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
