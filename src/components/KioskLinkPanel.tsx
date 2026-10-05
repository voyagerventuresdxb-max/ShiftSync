import { useEffect, useState } from 'react';
import { ApiError, fetchKioskLink, regenerateKioskLink, revokeKioskLink, type KioskLinkStatus } from '../api/kiosk';
import { useIdentity } from '../state/IdentityContext';

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * People › the venue's kiosk link: a shared screen at the venue opens it to
 * show this week's published rota, announcements and shoutouts without a
 * personal sign-in. The link is shown once, right after it is created; after
 * that the panel only says whether one is active. Creating a new one or
 * revoking stops the current one at once. Manager-only.
 */
export default function KioskLinkPanel({ locationId }: { locationId: string }) {
  const { session } = useIdentity();
  const [active, setActive] = useState<KioskLinkStatus | null>(null);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'idle' | 'regenerate' | 'revoke'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchKioskLink(session.token, locationId)
      .then((status) => {
        if (!cancelled) setActive(status);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the kiosk link.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, locationId]);

  const run = async (action: (token: string) => Promise<void>) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await action(session.token);
      setMode('idle');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    void run(async (token) => {
      const created = await regenerateKioskLink(token, locationId);
      setActive(created.active);
      setNewUrl(created.url);
    });
  const revoke = () =>
    void run(async (token) => {
      await revokeKioskLink(token, locationId);
      setActive(null);
      setNewUrl(null);
    });

  const copy = async () => {
    if (!newUrl) return;
    try {
      await navigator.clipboard.writeText(newUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked: the link is in the selectable field above.
    }
  };

  return (
    <section className="panel animate-rise p-4" aria-labelledby="kiosk-link-heading">
      <p className="eyebrow">Shared screen</p>
      <h2 id="kiosk-link-heading" className="text-base font-semibold tracking-tight">
        Kiosk link
      </h2>

      {loading ? (
        <p className="hint mt-3">Loading kiosk link…</p>
      ) : (
        <div className="mt-3 space-y-3">
          {newUrl && (
            <div className="space-y-2">
              <input
                readOnly
                aria-label="Kiosk link"
                value={newUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="staff-directory-input w-full font-mono text-xs"
              />
              <button className="btn btn-primary" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <p className="hint">Open it on the venue's shared screen. It's shown only now — to see a link again, create a new one.</p>
            </div>
          )}
          {active ? (
            <p className="text-xs text-muted-foreground">Active since {formatStamp(active.createdAt)}</p>
          ) : (
            <p className="hint">No kiosk link — a shared screen can't show the rota until you create one.</p>
          )}
          {error && (
            <div className="error-block" role="alert">
              <p>{error}</p>
            </div>
          )}

          {mode === 'regenerate' ? (
            <div className="space-y-3">
              <p className="hint">The current kiosk link stops working as soon as the new one is created.</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary" onClick={create} disabled={busy}>
                  {busy ? 'Creating…' : 'Create new link'}
                </button>
                <button className="btn btn-ghost" onClick={() => setMode('idle')} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          ) : mode === 'revoke' ? (
            <div className="space-y-3">
              <p className="hint">Revoke the kiosk link? Any screen using it stops showing the rota straight away.</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={revoke} disabled={busy}>
                  {busy ? 'Revoking…' : 'Yes, revoke'}
                </button>
                <button className="btn btn-ghost" onClick={() => setMode('idle')} disabled={busy}>
                  Keep it
                </button>
              </div>
            </div>
          ) : active ? (
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-ghost" onClick={() => setMode('regenerate')}>
                Regenerate
              </button>
              <button className="btn btn-ghost" onClick={() => setMode('revoke')}>
                Revoke
              </button>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={create} disabled={busy}>
              {busy ? 'Creating…' : 'Create kiosk link'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
