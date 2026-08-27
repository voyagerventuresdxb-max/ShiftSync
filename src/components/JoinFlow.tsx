import { useState } from 'react';
import { ApiError, requestJoinOtp, verifyJoinOtp } from '../api/join';
import { useIdentity } from '../state/IdentityContext';

type Phase = 'phone' | 'otp' | 'pending' | 'error';

export default function JoinFlow({ locationId }: { locationId: string }) {
  const { login } = useIdentity();
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      <h2 className="text-lg font-semibold">Join ShiftSync</h2>

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

      {phase === 'pending' && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          Thanks — your request has been submitted for review. A manager will approve your account shortly.
        </div>
      )}
    </section>
  );
}
