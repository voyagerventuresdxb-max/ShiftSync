/**
 * SMS delivery of sign-in codes (#51), behind `SMS_OTP_ENABLED` — OFF unless
 * it is exactly 'true'. Off, request-otp behaves exactly as before (no SMS;
 * the dev echo, lib/devOtpEcho.ts, is unchanged either way).
 *
 * One provider today: Twilio Programmable Messaging over its REST API (plain
 * `fetch`, no SDK). `SmsSender` is the seam for another (e.g. a UAE
 * aggregator) — see docs/otp-delivery-uae.md for why that may be needed.
 * Everything reads the env per call, so tests can vary it. Nothing here logs
 * a phone number, a code or a provider message body.
 */

export type SmsResult = { ok: true } | { ok: false; reason: 'not_configured' | 'rejected' | 'unavailable'; status?: number; providerCode?: number };

export interface SmsSender {
  send(to: string, body: string): Promise<SmsResult>;
}

export function smsOtpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SMS_OTP_ENABLED === 'true';
}

/** What `SMS_OTP_ENABLED=true` needs set; empty when complete. Names only, never values. */
export function missingSmsSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'].filter((name) => !env[name]?.trim());
  if (!env.TWILIO_MESSAGING_SERVICE_SID?.trim() && !env.SMS_SENDER_ID?.trim()) missing.push('TWILIO_MESSAGING_SERVICE_SID or SMS_SENDER_ID');
  return missing;
}

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const SEND_TIMEOUT_MS = 10_000;

/**
 * Twilio Programmable Messaging. Sends from the Messaging Service when
 * `TWILIO_MESSAGING_SERVICE_SID` is set (how a registered UAE sender ID is
 * usually attached), otherwise from `SMS_SENDER_ID`.
 */
export function twilioSender(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = (...args) => fetch(...args)): SmsSender {
  return {
    async send(to, body) {
      if (missingSmsSettings(env).length > 0) return { ok: false, reason: 'not_configured' };
      const sid = env.TWILIO_ACCOUNT_SID!.trim();
      const form = new URLSearchParams({ To: to, Body: body });
      const service = env.TWILIO_MESSAGING_SERVICE_SID?.trim();
      if (service) form.set('MessagingServiceSid', service);
      else form.set('From', env.SMS_SENDER_ID!.trim());
      let res: Response;
      try {
        res = await fetchImpl(`${TWILIO_API}/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN!.trim()}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (res.ok) return { ok: true };
      // Twilio's numeric error code is safe to log; its `message` can quote the number, so it is never read.
      const providerCode = await res
        .json()
        .then((j: unknown) => (typeof (j as { code?: unknown })?.code === 'number' ? (j as { code: number }).code : undefined))
        .catch(() => undefined);
      return { ok: false, reason: res.status === 429 || res.status >= 500 ? 'unavailable' : 'rejected', status: res.status, providerCode };
    },
  };
}

/** No link and no phone number in the body: UAE carriers block either in A2P traffic. */
export function otpSmsBody(code: string): string {
  return `${code} is your ShiftSync code. It expires in 5 minutes. Never share it.`;
}

export const SMS_SEND_FAILED_ERROR = "We couldn't text you a code just now. Please try again in a minute.";

/**
 * Called by every request-otp route after the code is minted. 'off' when the
 * flag is off (nothing sent), 'sent', or 'failed' (the route answers 503).
 */
export async function sendOtpSms(
  phone: string,
  code: string,
  scope: string,
  env: NodeJS.ProcessEnv = process.env,
  sender: SmsSender = twilioSender(env),
): Promise<'off' | 'sent' | 'failed'> {
  if (!smsOtpEnabled(env)) return 'off';
  const result = await sender.send(phone, otpSmsBody(code));
  if (result.ok) return 'sent';
  console.error(
    `[${scope}] OTP SMS not sent: ${result.reason}${result.status ? ` (HTTP ${result.status}${result.providerCode ? `, provider code ${result.providerCode}` : ''})` : ''}.`,
  );
  return 'failed';
}
