import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/schedules';

/**
 * Client side of the server's one-code-per-30s rule for a phone
 * (`OTP_PHONE_LIMITS` in server/src/lib/identity.ts): the "Send a new code"
 * button counts down for 30s after every code, so the common case never even
 * hits the server's 429. The server stays the source of truth: when a request
 * is refused anyway (a code was requested from another tab, or the hourly cap
 * is reached), the cooldown is reset from its `Retry-After`.
 */
export const RESEND_COOLDOWN_SECONDS = 30;

/** Seconds to wait after a refused request: the server's Retry-After when it sent one, else the standard cooldown. */
export function cooldownAfterRefusal(err: unknown): number {
  if (err instanceof ApiError && err.status === 429) return err.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS;
  return 0;
}

export function useResendCooldown(): { secondsLeft: number; start: (seconds?: number) => void; clear: () => void } {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const endsAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setInterval(() => {
      const endsAt = endsAtRef.current;
      const left = endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setSecondsLeft(left);
    }, 250);
    return () => clearInterval(id);
  }, [secondsLeft]);

  const start = useCallback((seconds: number = RESEND_COOLDOWN_SECONDS) => {
    endsAtRef.current = Date.now() + seconds * 1000;
    setSecondsLeft(seconds);
  }, []);
  const clear = useCallback(() => {
    endsAtRef.current = null;
    setSecondsLeft(0);
  }, []);

  return { secondsLeft, start, clear };
}
