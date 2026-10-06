import { Suspense, lazy, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useIdentity } from '../state/IdentityContext';
import { ACCOUNT_DELETED_REASON, deleteAccount } from '../api/identity';
import { hasVoiceConsent, withdrawVoiceConsent } from '../lib/voiceConsent';

// Owner-only, so staff never download it.
const AiConnectionPanel = lazy(() => import('../components/AiConnectionPanel'));

export default function ProfileContent() {
  const { session, logout } = useIdentity();
  const navigate = useNavigate();
  // 'confirm' shows what deletion does before anything happens; nothing is sent until the second click.
  const [step, setStep] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [voiceAgreed, setVoiceAgreed] = useState(() => (session ? hasVoiceConsent(session.user.id) : false));

  if (!session) {
    return <p className="panel p-5 text-sm text-muted-foreground">Sign in via Join to see your profile.</p>;
  }

  const onDelete = async () => {
    setStep('deleting');
    setError(null);
    try {
      await deleteAccount(session.token);
      // The server already ended every session, so there is nothing left to sign out of.
      logout({ revoke: false });
      navigate(`/login?reason=${ACCOUNT_DELETED_REASON}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete your account. Try again.');
      setStep('confirm');
    }
  };

  return (
    <div className="space-y-5">
      <section className="panel p-5">
        <p className="eyebrow">Account</p>
        <h2 className="text-lg font-semibold">{session.user.fullName}</h2>
        {session.user.jobTitle && <p className="text-sm text-muted-foreground">{session.user.jobTitle}</p>}
        <button className="btn btn-ghost mt-4" onClick={() => logout()}>
          Sign out
        </button>
      </section>

      {session.user.systemRole === 'OWNER' && (
        <Suspense fallback={null}>
          <AiConnectionPanel token={session.token} />
        </Suspense>
      )}

      <section className="panel p-5" data-testid="voice-consent">
        <p className="eyebrow">Voice commands</p>
        {voiceAgreed ? (
          <>
            <p className="text-sm text-muted-foreground">
              You agreed to voice commands on this device: your recordings are sent to Google's Gemini AI service to be turned into text.
            </p>
            <button
              className="btn btn-ghost mt-3 hit-44"
              onClick={() => {
                withdrawVoiceConsent(session.user.id);
                setVoiceAgreed(false);
              }}
            >
              Turn off voice on this device
            </button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Voice is off on this device. The microphone asks you again before it records anything.
          </p>
        )}
      </section>

      <section className="panel p-5" data-testid="delete-account">
        <p className="eyebrow">Delete account</p>
        {step === 'idle' ? (
          <>
            <p className="text-sm text-muted-foreground">Remove your account and your personal details from ShiftSync.</p>
            <button className="btn btn-ghost mt-3 hit-44" onClick={() => setStep('confirm')}>
              Delete my account…
            </button>
          </>
        ) : (
          <div role="alertdialog" aria-labelledby="delete-account-title">
            <p id="delete-account-title" className="text-sm font-semibold">
              Delete your account now?
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
              <li>This happens immediately and can't be undone.</li>
              <li>Your name, phone number and other personal details are removed, and you're signed out everywhere.</li>
              <li>Shifts and attendance you already worked stay in your venue's records, without your name.</li>
            </ul>
            {error && (
              <p className="error-block mt-3" role="alert">
                {error}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn btn-primary hit-44" onClick={onDelete} disabled={step === 'deleting'} data-testid="delete-account-confirm">
                {step === 'deleting' ? 'Deleting…' : 'Yes, delete my account'}
              </button>
              <button className="btn btn-ghost hit-44" onClick={() => setStep('idle')} disabled={step === 'deleting'}>
                Keep my account
              </button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              See the <Link to="/privacy">privacy policy (draft)</Link> for what is kept and why.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
