import { useState, type CSSProperties } from 'react';
import { ApiError, regenerateInviteLink, revokeInviteLink, type ActiveInvite } from '../api/invites';
import { describeInviteExpiry, describeInviteUses } from '../lib/inviteLinkFormat';
import { useIdentity } from '../state/IdentityContext';

const EXPIRY_DAYS = [7, 30, 90] as const;

type Part = 'meta' | 'text' | 'error' | 'label' | 'field' | 'button' | 'primary' | 'danger';

/** The same controls in two skins: the app's panel classes (/people) and the onboarding wizard's inline palette. */
const PANEL: Record<Part, { className: string; style?: CSSProperties }> = {
  meta: { className: 'text-xs text-muted-foreground' },
  text: { className: 'hint' },
  error: { className: 'error-block' },
  label: { className: 'text-xs text-muted-foreground' },
  field: { className: 'staff-directory-input' },
  button: { className: 'btn btn-ghost' },
  primary: { className: 'btn btn-primary' },
  danger: { className: 'btn btn-ghost text-destructive' },
};

const obButton: CSSProperties = {
  padding: '11px 14px',
  borderRadius: 10,
  border: '1px solid rgba(239,234,224,.12)',
  color: 'var(--ob-stone)',
  font: "500 10.5px/1 'Manrope'",
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  background: 'transparent',
};
const ONBOARDING: Record<Part, { className: string; style?: CSSProperties }> = {
  meta: { className: '', style: { font: "500 11px/1.4 'Manrope'", letterSpacing: '.02em', color: 'var(--ob-bronze)' } },
  text: { className: '', style: { font: "400 11.5px/1.5 'Manrope'", color: 'var(--ob-stone)' } },
  error: { className: '', style: { font: "400 12px/1.5 'Manrope'", color: '#e5484d' } },
  label: { className: '', style: { font: "500 9px/1 'Manrope'", letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--ob-bronze)' } },
  field: {
    className: '',
    style: { padding: '9px 10px', borderRadius: 9, border: '1px solid rgba(239,234,224,.12)', background: 'rgba(5,4,3,.55)', color: 'var(--ob-bone)', font: "500 12px/1.2 'Manrope'" },
  },
  button: { className: 'hit-44', style: obButton },
  primary: { className: 'hit-44', style: { ...obButton, border: '1px solid rgba(201,166,107,.6)', color: 'var(--ob-champagne)', background: 'rgba(201,166,107,.08)' } },
  danger: { className: 'hit-44', style: { ...obButton, border: '1px solid rgba(229,72,77,.5)', color: '#e5484d' } },
};

/**
 * Expiry/uses line plus Regenerate (expiry + optional max uses) and Revoke
 * (with a confirm step) for the venue's join link. With no active link it
 * offers Generate instead. Reports the new active link (or null) via `onChange`.
 */
export default function InviteLinkActions({
  locationId,
  active,
  onChange,
  look,
}: {
  locationId: string;
  active: ActiveInvite | null;
  onChange: (next: ActiveInvite | null) => void;
  look: 'panel' | 'onboarding';
}) {
  const { session } = useIdentity();
  const [mode, setMode] = useState<'idle' | 'regenerate' | 'revoke'>('idle');
  const [expiresInDays, setExpiresInDays] = useState<number>(30);
  const [maxUsesDraft, setMaxUsesDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = look === 'panel' ? PANEL : ONBOARDING;
  // Fixed size: .staff-directory-input's flex-basis would make it 12rem tall inside a column label (#47).
  const fieldStyle: CSSProperties = { ...s.field.style, flex: '0 0 auto' };

  const maxUses = maxUsesDraft.trim() === '' ? null : Number(maxUsesDraft);
  const maxUsesInvalid = maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000);

  const run = async (action: (token: string) => Promise<ActiveInvite | null>) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await action(session.token));
      setMode('idle');
      setMaxUsesDraft('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };
  const create = () => void run((token) => regenerateInviteLink(token, locationId, { expiresInDays, maxUses }));
  const revoke = () =>
    void run(async (token) => {
      await revokeInviteLink(token, locationId);
      return null;
    });

  return (
    <div className="mt-3 space-y-3">
      {active && (
        <p className={s.meta.className} style={s.meta.style}>
          {describeInviteExpiry(active.expiresAt)} · {describeInviteUses(active.useCount, active.maxUses)}
        </p>
      )}
      {error && (
        <div className={s.error.className} style={s.error.style} role="alert">
          <p>{error}</p>
        </div>
      )}

      {!active || mode === 'regenerate' ? (
        <div className="space-y-3">
          {!active && (
            <p className={s.text.className} style={s.text.style}>
              No active join link — nobody can join until you generate one.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1.5">
              <span className={s.label.className} style={s.label.style}>
                Expires after
              </span>
              <select className={s.field.className} style={fieldStyle} value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
                {EXPIRY_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={s.label.className} style={s.label.style}>
                Max uses
              </span>
              <input
                className={s.field.className}
                style={{ ...fieldStyle, width: '8rem' }}
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                placeholder="Unlimited"
                value={maxUsesDraft}
                onChange={(e) => setMaxUsesDraft(e.target.value)}
              />
            </label>
          </div>
          {maxUsesInvalid && (
            <p className={s.text.className} style={s.text.style}>
              Max uses is a whole number from 1 to 1000 — or leave it empty for unlimited.
            </p>
          )}
          {active && (
            <p className={s.text.className} style={s.text.style}>
              The current link stops working as soon as the new one is created.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button className={s.primary.className} style={s.primary.style} onClick={create} disabled={busy || maxUsesInvalid}>
              {busy ? 'Creating…' : active ? 'Create new link' : 'Generate link'}
            </button>
            {active && (
              <button className={s.button.className} style={s.button.style} onClick={() => setMode('idle')} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : mode === 'revoke' ? (
        <div className="space-y-3">
          <p className={s.text.className} style={s.text.style}>
            Revoke this link? It stops working straight away — anyone who hasn't joined yet will need a new one.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className={s.danger.className} style={s.danger.style} onClick={revoke} disabled={busy}>
              {busy ? 'Revoking…' : 'Yes, revoke'}
            </button>
            <button className={s.button.className} style={s.button.style} onClick={() => setMode('idle')} disabled={busy}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className={s.button.className} style={s.button.style} onClick={() => setMode('regenerate')}>
            Regenerate
          </button>
          <button className={s.button.className} style={s.button.style} onClick={() => setMode('revoke')}>
            Revoke
          </button>
        </div>
      )}
    </div>
  );
}
