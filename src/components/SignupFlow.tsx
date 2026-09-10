import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ApiError, requestSignupOtp, verifySignupOtp } from '../api/signup';
import { useIdentity } from '../state/IdentityContext';

/**
 * Sign-up-a-brand-new-venue flow — a sibling of `JoinFlow`, not a mode bolted
 * onto it. `JoinFlow` is "join an existing venue's roster"; this is "stand up
 * a new venue and become its Owner." Different backend route
 * (`/api/signup`), different outcome (a new Organization+Location+User(OWNER)
 * rather than matching/filing a request against one that already exists),
 * different copy.
 *
 *  - 'phone'  — enter phone, request a code.
 *  - 'otp'    — enter the code plus the two facts a brand-new venue needs
 *               (owner's full name, venue name) in one step, matching
 *               `JoinFlow`'s pattern of collecting fullName alongside the
 *               code rather than as a separate screen.
 *  - 'exists' — the phone already has an account (409 from the server) —
 *               this is not a generic error, it's a known outcome with a real
 *               next step, so it gets its own phase with a link to log in
 *               instead of a dead-end inline banner.
 */
type Phase = 'phone' | 'otp' | 'exists';

export default function SignupFlow() {
  const { login } = useIdentity();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [venueName, setVenueName] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRequestOtp = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await requestSignupOtp(phone);
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
      const result = await verifySignupOtp({ phone, code, fullName: fullName.trim(), venueName: venueName.trim() });
      login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
      navigate('/onboarding');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setPhase('exists');
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not verify that code.');
    } finally {
      setSubmitting(false);
    }
  };

  const canVerify = code.trim() && fullName.trim() && venueName.trim();

  return (
    <section className="panel mx-auto max-w-md p-6">
      <h2 className="text-lg font-semibold">Sign up your restaurant</h2>
      <p className="hint mt-1">
        {phase === 'exists'
          ? 'One more thing before you get your roster live.'
          : "Set up your venue on ShiftSync — you'll be its owner. Takes under a minute."}
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
            placeholder="Your full name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
          <input
            className="staff-directory-input w-full"
            placeholder="Venue name"
            value={venueName}
            onChange={(e) => setVenueName(e.target.value)}
          />
          <button className="btn btn-primary w-full" onClick={() => void handleVerify()} disabled={submitting || !canVerify}>
            {submitting ? 'Verifying…' : 'Verify & create venue'}
          </button>
        </div>
      )}

      {phase === 'exists' && (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
            An account already exists for this phone number — log in instead.
          </div>
          <Link to="/join?mode=login" className="btn btn-primary w-full inline-flex items-center justify-center">
            Log in
          </Link>
        </div>
      )}

      {phase !== 'exists' && (
        <p className="mt-5 text-xs text-muted-foreground">
          Joining a team that already uses ShiftSync?{' '}
          <Link to="/join" className="underline-offset-2 hover:text-foreground hover:underline">
            Join instead
          </Link>
        </p>
      )}
    </section>
  );
}
