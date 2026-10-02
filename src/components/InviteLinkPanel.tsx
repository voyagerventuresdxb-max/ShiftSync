import { useEffect, useState } from 'react';
import { ApiError, fetchInviteLink, type ActiveInvite } from '../api/invites';
import { useIdentity } from '../state/IdentityContext';
import InviteLinkActions from './InviteLinkActions';

/** People › the venue's join link: copy / WhatsApp / QR, plus regenerate and revoke. Manager-only. */
export default function InviteLinkPanel({ locationId }: { locationId: string }) {
  const { session } = useIdentity();
  const [active, setActive] = useState<ActiveInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchInviteLink(session.token, locationId)
      .then((link) => !cancelled && setActive(link))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Could not load the join link.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, locationId]);

  const copy = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked: the link is in the selectable field above.
    }
  };

  const saveQr = () => {
    if (!active) return;
    const a = document.createElement('a');
    a.href = active.qrDataUrl;
    a.download = 'shiftsync-join-qr.png';
    a.click();
  };

  return (
    <section className="panel animate-rise p-4" aria-labelledby="invite-link-heading">
      <p className="eyebrow">Invite your team</p>
      <h2 id="invite-link-heading" className="text-base font-semibold tracking-tight">
        Join link
      </h2>

      {loading ? (
        <p className="hint mt-3">Loading join link…</p>
      ) : error ? (
        <div className="error-block mt-3" role="alert">
          <p>{error}</p>
        </div>
      ) : (
        <>
          {active && (
            <div className="mt-3 flex items-start gap-3">
              <img src={active.qrDataUrl} alt="Join link QR code" className="h-20 w-20 shrink-0 rounded-md bg-white p-1" />
              <div className="min-w-0 flex-1 space-y-2">
                <input
                  readOnly
                  aria-label="Join link"
                  value={active.inviteUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="staff-directory-input w-full font-mono text-xs"
                />
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-primary" onClick={() => void copy()}>
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <a className="btn btn-ghost" href={active.whatsappUrl} target="_blank" rel="noreferrer">
                    WhatsApp
                  </a>
                  <button className="btn btn-ghost" onClick={saveQr}>
                    Save QR
                  </button>
                </div>
              </div>
            </div>
          )}
          <InviteLinkActions locationId={locationId} active={active} onChange={setActive} look="panel" />
        </>
      )}
    </section>
  );
}
