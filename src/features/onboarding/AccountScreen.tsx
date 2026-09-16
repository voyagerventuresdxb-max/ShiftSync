import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, requestSignupOtp, verifySignupOtp } from '../../api/signup';
import { useIdentity } from '../../state/IdentityContext';
import OnboardingScreenShell from './OnboardingScreenShell';

/**
 * Onboarding · 01 · Account — account creation as the wizard's first real
 * step (2026-09-16, onboarding QA round 1), replacing the standalone
 * `/signup` screen (`SignupFlow`, now deleted) that used to sit in front of
 * the wizard in the generic app-shell look and read as a gate you passed
 * through before "real" onboarding began.
 *
 * The backend contract is unchanged — `/api/signup/request-otp` then
 * `/api/signup/verify-otp` (`server/src/routes/signup.ts`), which creates the
 * Organization + Location + Owner User and mints the session in one call.
 * That's why the venue's name is asked for here alongside the code and the
 * owner's name: the server needs it to create the Location. Venue (the next
 * step) loads that Location and lets the manager refine it (type, city,
 * floor sections).
 *
 *  - 'phone'  — enter phone, request a code.
 *  - 'otp'    — the code plus the two facts a brand-new venue needs.
 *  - 'exists' — the phone already has an account (409) — a known outcome
 *               with a real next step (log in), not a generic error.
 */
type Phase = 'phone' | 'otp' | 'exists';

const LABEL: React.CSSProperties = { font: "500 10px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' };
const INPUT: React.CSSProperties = {
  font: "400 20px/1.2 'Instrument Serif'",
  color: 'var(--ob-bone)',
  padding: '12px 0 12px',
  width: '100%',
  background: 'transparent',
  border: 0,
  outline: 'none',
};

function Field({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={LABEL}>{label}</div>
      <div
        style={{
          marginTop: 6,
          borderBottom: `1px solid ${value ? 'rgba(201,166,107,.55)' : 'rgba(239,234,224,.12)'}`,
          transition: 'border-color var(--ob-t)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function SecondaryLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      style={{ color: 'var(--ob-champagne)', borderBottom: '1px solid rgba(201,166,107,.35)', paddingBottom: 1, textDecoration: 'none' }}
    >
      {children}
    </Link>
  );
}

export default function AccountScreen({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const { login } = useIdentity();
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [venueName, setVenueName] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRequestOtp = async () => {
    if (submitting || !phone.trim()) return;
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

  const canVerify = !!(code.trim() && fullName.trim() && venueName.trim());

  const handleVerify = async () => {
    if (submitting || !canVerify) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await verifySignupOtp({ phone, code, fullName: fullName.trim(), venueName: venueName.trim() });
      login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
      onContinue();
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

  const primaryEnabled = phase === 'phone' ? !!phone.trim() && !submitting : phase === 'otp' ? canVerify && !submitting : true;
  const primaryStyle: React.CSSProperties = {
    width: '100%',
    display: 'block',
    textAlign: 'center',
    textDecoration: 'none',
    padding: '16px 20px',
    borderRadius: 14,
    background: primaryEnabled ? 'var(--ob-bone)' : 'rgba(239,234,224,.10)',
    color: primaryEnabled ? '#100D0A' : 'var(--ob-dim-2)',
    font: "600 14px/1 'Manrope'",
    letterSpacing: '.005em',
    transition: 'background-color var(--ob-t), color var(--ob-t)',
    cursor: primaryEnabled ? 'pointer' : 'default',
  };

  const title = phase === 'phone' ? 'First, your number.' : phase === 'otp' ? 'Check your messages.' : 'You’re already here.';

  return (
    <OnboardingScreenShell
      stepIndex={0}
      eyebrow="Step 1 of 5 · Account"
      title={title}
      onBack={phase === 'otp' ? () => { setPhase('phone'); setCode(''); setError(null); } : onBack}
      footer={
        <>
          {phase === 'phone' && (
            <button onClick={() => void handleRequestOtp()} disabled={!primaryEnabled} style={primaryStyle}>
              {submitting ? 'Sending…' : 'Send code'}
            </button>
          )}
          {phase === 'otp' && (
            <button onClick={() => void handleVerify()} disabled={!primaryEnabled} style={primaryStyle}>
              {submitting ? 'Verifying…' : 'Verify & continue'}
            </button>
          )}
          {phase === 'exists' && (
            <Link to="/join?mode=login&returnTo=%2Fonboarding%2Fvenue" style={primaryStyle}>
              Log in
            </Link>
          )}
          <div style={{ textAlign: 'center', marginTop: 14, font: "500 10px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-dim-2)' }}>
            Next · Venue
          </div>
          {phase !== 'exists' && (
            <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', font: "400 12px/1.4 'Manrope'", color: 'var(--ob-dim)' }}>
              <span>
                Already have an account? <SecondaryLink to="/join?mode=login&returnTo=%2Fonboarding%2Fvenue">Log in</SecondaryLink>
              </span>
              <span>
                Joining a team that already uses ShiftSync? <SecondaryLink to="/join">Join instead</SecondaryLink>
              </span>
            </div>
          )}
        </>
      }
    >
      {error && <div style={{ color: '#e5484d', font: "400 13px/1.5 'Manrope'" }}>{error}</div>}

      {phase === 'phone' && (
        <>
          <div style={{ font: "400 14px/1.55 'Manrope'", color: 'var(--ob-stone)', maxWidth: 300 }}>
            We&apos;ll text you a one-time code. You&apos;ll be this venue&apos;s owner — it takes under a minute.
          </div>
          <Field label="Mobile number" value={phone}>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRequestOtp();
              }}
              placeholder="+971 50 123 4567"
              disabled={submitting}
              autoFocus
              style={INPUT}
            />
          </Field>
        </>
      )}

      {phase === 'otp' && (
        <>
          <div style={{ font: "400 14px/1.55 'Manrope'", color: 'var(--ob-stone)', maxWidth: 300 }}>
            Enter the 6-digit code we sent to <span style={{ color: 'var(--ob-bone)' }}>{phone}</span>.
          </div>
          {devCode && (
            <button
              type="button"
              onClick={() => setCode(devCode)}
              style={{
                alignSelf: 'flex-start',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(201,166,107,.25)',
                background: 'rgba(201,166,107,.06)',
                color: 'var(--ob-bronze)',
                font: "500 10px/1 'Manrope'",
                letterSpacing: '.18em',
                textTransform: 'uppercase',
              }}
            >
              Dev code
              <span data-dev-code style={{ font: "400 16px/1 'Instrument Serif'", letterSpacing: '.18em', color: 'var(--ob-champagne)', textTransform: 'none' }}>
                {devCode}
              </span>
            </button>
          )}
          <Field label="Code" value={code}>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="······"
              disabled={submitting}
              autoFocus
              style={{ ...INPUT, letterSpacing: '.32em' }}
            />
          </Field>
          <Field label="Your name" value={fullName}>
            <input
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Layla Haddad"
              disabled={submitting}
              style={INPUT}
            />
          </Field>
          <Field label="Venue name" value={venueName}>
            <input
              autoComplete="organization"
              value={venueName}
              onChange={(e) => setVenueName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleVerify();
              }}
              placeholder="e.g. Sefarina, DIFC"
              disabled={submitting}
              style={INPUT}
            />
          </Field>
        </>
      )}

      {phase === 'exists' && (
        <div
          style={{
            padding: '16px 18px',
            borderRadius: 14,
            border: '1px solid rgba(201,166,107,.25)',
            background: 'rgba(201,166,107,.06)',
            font: "400 14px/1.55 'Manrope'",
            color: 'var(--ob-stone)',
          }}
        >
          An account already exists for <span style={{ color: 'var(--ob-bone)' }}>{phone}</span>. Log in to pick up where you left off.
        </div>
      )}
    </OnboardingScreenShell>
  );
}
