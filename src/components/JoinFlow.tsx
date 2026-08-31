import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, requestJoinOtp, verifyJoinOtp } from '../api/join';
import { requestLoginOtp, verifyLoginOtp } from '../api/identity';
import { useIdentity } from '../state/IdentityContext';

type Phase = 'phone' | 'otp' | 'pending' | 'error';
/**
 * Two flows share this one screen because they're the same three steps with a
 * different endpoint behind them:
 *  - 'join'  — self-registration: auto-matches an existing roster row by phone,
 *              otherwise files a JoinRequest for manual approval ('pending').
 *  - 'login' — an existing staff member coming back after their session
 *              expired or was revoked. No full name (we already know it), and
 *              no 'pending' branch — login either issues a session or errors.
 * Without the login mode the identity route had no reachable UI at all, and an
 * expired session was a dead end.
 */
type Mode = 'join' | 'login';

export default function JoinFlow({ locationId, initialMode }: { locationId?: string; initialMode?: Mode }) {
  const { login } = useIdentity();
  const [mode, setMode] = useState<Mode>(initialMode ?? 'join');
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isLogin = mode === 'login';

  /** Switching flows restarts from the phone step — a code minted for one purpose can't be replayed against the other. */
  const switchMode = (next: Mode) => {
    setMode(next);
    setPhase('phone');
    setCode('');
    setDevCode(null);
    setError(null);
  };

  const handleRequestOtp = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Login is global by phone — no locationId needed (see identity.ts) —
      // which is exactly what lets this screen work when reached from
      // RequireSession's redirect, which has no venue context to give it.
      // Join still needs one; JoinRoute.tsx already refuses to render this
      // component in join mode without a real location, so this is a
      // type-narrowing guard, not a real code path in practice.
      if (!isLogin && !locationId) throw new ApiError('This link is missing venue information.', 400);
      const res = isLogin ? await requestLoginOtp(phone) : await requestJoinOtp(phone);
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
      if (isLogin) {
        const result = await verifyLoginOtp(phone, code);
        login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
        window.location.href = '/my-shifts';
        return;
      }
      if (!locationId) throw new ApiError('This link is missing venue information.', 400);
      const result = await verifyJoinOtp({ locationId, phone, code, fullName: fullName.trim() || undefined });
      if (result.pending) {
        setPhase('pending');
      } else {
        login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
        window.location.href = '/my-shifts';
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel mx-auto max-w-md p-6">
      <h2 className="text-lg font-semibold">{isLogin ? 'Log in to ShiftSync' : 'Join ShiftSync'}</h2>
      <p className="hint mt-1">
        {isLogin
          ? "We'll text a code to the number your venue has on file."
          : "New here? We'll match your number against your venue's roster."}
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
          {!isLogin && (
            <input
              className="staff-directory-input w-full"
              placeholder="Full name (if this is your first time)"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          )}
          <button className="btn btn-primary w-full" onClick={() => void handleVerify()} disabled={submitting || !code.trim()}>
            {submitting ? 'Verifying…' : isLogin ? 'Verify & log in' : 'Verify & continue'}
          </button>
        </div>
      )}

      {phase === 'pending' && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          Thanks — your request has been submitted for review. A manager will approve your account shortly.
        </div>
      )}

      {/*
       * Switching TO join mode needs a real `locationId` to join into — this
       * screen only has one when a real invite link provided it. Reached
       * with none (e.g. RequireSession's redirect for a signed-out visit,
       * which has no venue context to give), offering "Join" here would
       * lead straight into the dead end `handleRequestOtp`/`handleVerify`
       * already guard against — so the toggle only offers switching TO join
       * mode when there's actually a venue to join, and the /signup link
       * below stands in as the real next step otherwise.
       */}
      {phase !== 'pending' && (isLogin ? Boolean(locationId) : true) && (
        <button
          type="button"
          className="mt-5 w-full text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          onClick={() => switchMode(isLogin ? 'join' : 'login')}
        >
          {isLogin ? "Don't have an account yet? Join" : 'Already have an account? Log in'}
        </button>
      )}

      {/*
       * This screen is for joining a venue's EXISTING roster — someone
       * looking to stand up a brand-new venue for the first time (the exact
       * confusion behind the home-base user report this was added for)
       * belongs on /signup instead, not merged into this flow. Shown
       * whenever join mode isn't actually reachable here (no locationId) —
       * not just whenever the CURRENT mode happens to be join — since a
       * locationId-less login screen has no working path to join at all.
       */}
      {phase !== 'pending' && (!isLogin || !locationId) && (
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
