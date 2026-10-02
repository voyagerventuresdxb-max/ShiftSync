import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, requestJoinOtp, verifyJoinOtp } from '../api/join';
import { useIdentity } from '../state/IdentityContext';
import { postLoginDestination } from '../lib/postLoginDestination';

type Phase = 'phone' | 'otp' | 'pending' | 'error';
/**
 * Self-registration: auto-matches an existing roster row by phone, otherwise
 * files a JoinRequest for manual approval ('pending'). Logging back in to an
 * existing account lives at `/login` (`LoginRoute.tsx`).
 */
export default function JoinFlow({ locationId }: { locationId: string }) {
  const { login } = useIdentity();
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingOn, setWaitingOn] = useState<{ venueName: string; managerName: string | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRequestOtp = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await requestJoinOtp(phone);
      setDevCode(res.devCode ?? null);
      setPhase('otp');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request a code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await verifyJoinOtp({ locationId, phone, code, fullName: fullName.trim() || undefined });
      if (result.pending) {
        setWaitingOn({ venueName: result.venueName, managerName: result.managerName });
        setPhase('pending');
      } else {
        login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
        // Never a returnTo: a fresh join wasn't bounced from anywhere, and an
        // unsigned invite link could otherwise redirect a new hire anywhere.
        window.location.href = postLoginDestination(result.user.systemRole);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel mx-auto max-w-md p-6">
      <h2 className="text-lg font-semibold">Join ShiftSync</h2>
      <p className="hint mt-1">New here? We'll match your number against your venue's roster.</p>

      {error && (
        <div className="error-block mt-3" role="alert">
          <p>{error}</p>
        </div>
      )}

      {phase === 'phone' && (
        <div className="mt-4 space-y-3">
          <input
            className="staff-directory-input w-full"
            placeholder="Phone number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button className="btn btn-primary w-full" onClick={() => void handleRequestOtp()} disabled={submitting || !phone.trim()}>
            {submitting ? 'Sending…' : 'Send code'}
          </button>
        </div>
      )}

      {phase === 'otp' && (
        <div className="mt-4 space-y-3">
          {devCode && (
            <p className="hint">Dev mode — your code is <span className="font-mono font-semibold">{devCode}</span> (no SMS is sent in this environment).</p>
          )}
          <input
            className="staff-directory-input w-full"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <input
            className="staff-directory-input w-full"
            placeholder="Full name (if this is your first time)"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
          <button className="btn btn-primary w-full" onClick={() => void handleVerify()} disabled={submitting || !code.trim()}>
            {submitting ? 'Verifying…' : 'Verify & continue'}
          </button>
        </div>
      )}

      {phase === 'pending' && waitingOn && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning" role="status">
          Waiting for {waitingOn.managerName ?? 'a manager'} to approve you at {waitingOn.venueName}. Sign in again once you've been
          approved.
        </div>
      )}

      {phase !== 'pending' && (
        <Link
          to="/login"
          className="mt-5 block w-full text-center text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Already have an account? Log in
        </Link>
      )}

      {/*
       * This screen is for joining a venue's EXISTING roster — someone
       * looking to stand up a brand-new venue for the first time (the exact
       * confusion behind the home-base user report this was added for)
       * belongs on /signup instead, not merged into this flow.
       */}
      {phase !== 'pending' && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Setting up a brand-new venue?{' '}
          <Link to="/signup" className="underline-offset-2 hover:text-foreground hover:underline">
            Sign up your restaurant
          </Link>
        </p>
      )}
    </section>
  );
}
