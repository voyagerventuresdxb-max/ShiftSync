import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ApiError, requestLoginOtp, verifyLoginOtp } from '../api/identity';
import { useIdentity } from '../state/IdentityContext';
import { postLoginDestination } from '../lib/postLoginDestination';

type Phase = 'phone' | 'code';

/**
 * One sign-in screen for every role (phone → OTP). The destination is
 * decided by `postLoginDestination`: a safe `?returnTo=` wins, else
 * OWNER/MANAGER → `/`, STAFF → `/my-shifts`.
 */
export default function LoginContent() {
  const { session, login } = useIdentity();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('returnTo');
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [waitingOn, setWaitingOn] = useState<{ venueName: string; managerName: string | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Also the post-verify redirect: `login()` below sets `session`.
  if (session) return <Navigate to={postLoginDestination(session.user.systemRole, returnTo)} replace />;

  const requestCode = async () => {
    setSubmitting(true);
    setError(null);
    setNoAccount(false);
    setWaitingOn(null);
    try {
      const res = await requestLoginOtp(phone);
      setDevCode(res.devCode ?? null);
      setCode('');
      setPhase('code');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNoAccount(true);
        setError('No account with that number.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not request a code.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const verify = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await verifyLoginOtp(phone, code);
      if (result.pending) {
        // No session yet: back to the phone step so they can sign in again once approved.
        setWaitingOn({ venueName: result.venueName, managerName: result.managerName });
        setPhase('phone');
        setCode('');
        setDevCode(null);
        return;
      }
      login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code.');
    } finally {
      setSubmitting(false);
    }
  };

  const changeNumber = () => {
    setPhase('phone');
    setCode('');
    setDevCode(null);
    setError(null);
    setNoAccount(false);
    setWaitingOn(null);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (phase === 'phone' && phone.trim()) void requestCode();
    if (phase === 'code' && code.trim()) void verify();
  };

  return (
    <section className="panel mx-auto max-w-md p-6">
      <h2 className="text-lg font-semibold">Log in to ShiftSync</h2>
      <p className="hint mt-1">
        {phase === 'phone' ? "We'll text a code to the number your venue has on file." : `Enter the code we sent to ${phone}.`}
      </p>

      {error && (
        <div className="error-block mt-3" role="alert">
          <p>{error}</p>
          {noAccount && (
            <>
              <p className="mt-1">Joining a team? Use your venue's invite link.</p>
              <p className="mt-1">
                Setting up a new venue?{' '}
                <Link to="/onboarding" className="underline underline-offset-2">
                  Set up your venue
                </Link>
              </p>
            </>
          )}
        </div>
      )}

      {waitingOn && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning" role="status">
          Waiting for {waitingOn.managerName ?? 'a manager'} to approve you at {waitingOn.venueName}. Sign in again once you've been
          approved.
        </div>
      )}

      <form className="mt-4 space-y-3" onSubmit={onSubmit}>
        {phase === 'phone' && (
          <>
            <input
              className="staff-directory-input w-full"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              aria-label="Phone number"
              placeholder="Phone number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
              autoFocus
            />
            <button type="submit" className="btn btn-primary w-full" disabled={submitting || !phone.trim()}>
              {submitting ? 'Sending…' : 'Send code'}
            </button>
          </>
        )}

        {phase === 'code' && (
          <>
            {devCode && (
              <p className="hint">Dev mode — your code is <span className="font-mono font-semibold">{devCode}</span> (no SMS is sent in this environment).</p>
            )}
            <input
              className="staff-directory-input w-full"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              aria-label="6-digit code"
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              disabled={submitting}
              autoFocus
            />
            <button type="submit" className="btn btn-primary w-full" disabled={submitting || !code.trim()}>
              {submitting ? 'Verifying…' : 'Verify & log in'}
            </button>
            <div className="flex justify-between gap-3">
              <button
                type="button"
                className="hit-44 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                onClick={changeNumber}
                disabled={submitting}
              >
                Use a different number
              </button>
              <button
                type="button"
                className="hit-44 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                onClick={() => void requestCode()}
                disabled={submitting}
              >
                Send a new code
              </button>
            </div>
          </>
        )}
      </form>

      <p className="mt-5 text-center text-xs text-muted-foreground">
        Setting up a brand-new venue?{' '}
        <Link to="/onboarding" className="underline-offset-2 hover:text-foreground hover:underline">
          Sign up your restaurant
        </Link>
      </p>
    </section>
  );
}
