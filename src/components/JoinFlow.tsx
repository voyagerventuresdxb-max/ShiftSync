import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, requestJoinOtp, verifyJoinOtp } from '../api/join';
import { useIdentity } from '../state/IdentityContext';
import { postLoginDestination } from '../lib/postLoginDestination';
import { shouldShowStaffWelcome, stashStaffWelcome, STAFF_LOGIN_PATH, WELCOME_PATH } from '../lib/staffWelcome';

type Phase = 'phone' | 'otp' | 'pending' | 'error';
/**
 * Self-registration: auto-matches an existing roster row by phone, otherwise
 * files a JoinRequest for manual approval ('pending'). Logging back in to an
 * existing account lives at `/login` (`LoginRoute.tsx`). Joins through an
 * invite link's `inviteToken`, or an old link's `locationId` (the server
 * decides whether that is still honoured).
 */
export default function JoinFlow({ inviteToken, locationId, venueName }: { inviteToken?: string; locationId?: string; venueName?: string }) {
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
      const link = inviteToken ? { inviteToken } : { locationId };
      const result = await verifyJoinOtp({ ...link, phone, code, fullName: fullName.trim() || undefined });
      if (result.pending) {
        setWaitingOn({ venueName: result.venueName, managerName: result.managerName });
        setPhase('pending');
      } else {
        // A first sign-in (phone matched the roster) gets the one-time "You're in" screen.
        if (shouldShowStaffWelcome(result)) stashStaffWelcome(result.venueName ?? venueName);
        login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
        // Never a returnTo: a fresh join wasn't bounced from anywhere, and an
        // unsigned invite link could otherwise redirect a new hire anywhere.
        window.location.href = shouldShowStaffWelcome(result) ? WELCOME_PATH : postLoginDestination(result.user.systemRole);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel mx-auto max-w-md p-6" data-audience="staff">
      <p className="eyebrow">Staff</p>
      <h2 className="text-lg font-semibold">{venueName ? `Join ${venueName} as staff` : 'Join your venue as staff'}</h2>
      <p className="hint mt-1">
        {venueName
          ? `Welcome to the ${venueName} team. Enter your mobile number and we'll text you a code — your manager approves you from there.`
          : "Enter your mobile number and we'll text you a code — your manager approves you from there."}
      </p>

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
      {phase === 'pending' && (
        <Link to={STAFF_LOGIN_PATH} className="btn btn-ghost mt-4 w-full">
          Staff sign in
        </Link>
      )}

      {/*
       * Staff-only screen: no venue-setup or manager wording here. Someone who
       * wants to set up a brand-new venue starts from the manager login.
       */}
      {phase !== 'pending' && (
        <Link
          to={STAFF_LOGIN_PATH}
          className="mt-5 block w-full text-center text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Already on the team? Staff sign in
        </Link>
      )}
    </section>
  );
}
