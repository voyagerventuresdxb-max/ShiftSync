import { useState } from 'react';
import ShiftUpload from './ShiftUpload';

type Step = 'venue' | 'roster' | 'review' | 'invite';

interface Invite {
  inviteUrl: string;
  qrDataUrl: string;
  whatsappUrl: string;
}

export default function OnboardingWizard({ locationId }: { locationId: string }) {
  const [step, setStep] = useState<Step>('venue');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loadingInvite, setLoadingInvite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInvite = async () => {
    setError(null);
    setLoadingInvite(true);
    try {
      const res = await fetch(`/api/onboarding/${locationId}/invite`);
      if (!res.ok) throw new Error('Could not generate the invite link.');
      const data = (await res.json()) as Invite;
      setInvite(data);
      setStep('invite');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the invite link.');
    } finally {
      setLoadingInvite(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex gap-2">
        {(['venue', 'roster', 'review', 'invite'] as const).map((s) => (
          <span
            key={s}
            className={`rounded-full px-3 py-1 text-xs font-medium ${step === s ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground'}`}
          >
            {s}
          </span>
        ))}
      </div>

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      {step === 'venue' && (
        <section className="panel p-5">
          <p className="hint">Confirm your venue details, then move on to importing your existing roster.</p>
          <button className="btn btn-primary mt-4" onClick={() => setStep('roster')}>
            Continue
          </button>
        </section>
      )}

      {step === 'roster' && (
        <section className="panel p-5">
          <p className="hint mb-3">
            Upload your existing roster (Excel, CSV, PDF, or a photo) — this uses the same real parser as the
            Scheduling page's upload tool, not a separate mock.
          </p>
          <ShiftUpload locationId={locationId} onCommitted={() => setStep('review')} />
          <button className="btn btn-ghost mt-4" onClick={() => setStep('review')}>
            Skip for now
          </button>
        </section>
      )}

      {step === 'review' && (
        <section className="panel p-5">
          <p className="hint">Your roster has been imported. When you're ready, generate an invite link for your team to join.</p>
          <button className="btn btn-primary mt-4" onClick={() => void loadInvite()} disabled={loadingInvite}>
            {loadingInvite ? 'Generating…' : 'Generate invite'}
          </button>
        </section>
      )}

      {step === 'invite' && invite && (
        <section className="panel p-5 text-center">
          <img src={invite.qrDataUrl} alt="Invite QR code" className="mx-auto h-48 w-48" />
          <p className="mt-3 break-all text-sm text-muted-foreground">{invite.inviteUrl}</p>
          <a href={invite.whatsappUrl} target="_blank" rel="noreferrer" className="btn btn-primary mt-4 inline-flex">
            Share via WhatsApp
          </a>
        </section>
      )}
    </div>
  );
}
