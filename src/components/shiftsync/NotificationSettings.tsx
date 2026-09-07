import { useEffect, useState } from 'react';
import { BellRing, BellOff } from 'lucide-react';
import { useIdentity } from '../../state/IdentityContext';
import {
  isPushSupported,
  getPushPermissionState,
  getExistingSubscriptionEndpoint,
  subscribeToPush,
  unsubscribeFromPush,
} from '../../lib/push';

type Status = 'checking' | 'unsupported' | 'denied' | 'subscribed' | 'not-subscribed';

/**
 * The explicit opt-in for Web Push, replacing ProfileRoute's old
 * placeholder section. Never requests Notification permission on its own
 * mount — only the "Enable notifications" button's click handler does that
 * (see src/lib/push.ts's subscribeToPush), since prompting on load is what
 * gets a site's notifications auto-blocked by the browser.
 */
export function NotificationSettings() {
  const { session } = useIdentity();
  const [status, setStatus] = useState<Status>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!isPushSupported()) {
      setStatus('unsupported');
      return;
    }
    const permission = getPushPermissionState();
    if (permission === 'denied') {
      setStatus('denied');
      return;
    }
    const endpoint = await getExistingSubscriptionEndpoint();
    setStatus(endpoint ? 'subscribed' : 'not-subscribed');
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEnable = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const result = await subscribeToPush(session.token);
      if (result.ok) {
        setStatus('subscribed');
      } else if (result.reason === 'denied') {
        setStatus('denied');
      } else if (result.reason === 'unsupported') {
        setStatus('unsupported');
      } else {
        setError(result.message ?? 'Could not enable push notifications.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await unsubscribeFromPush(session.token);
      setStatus('not-subscribed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn off push notifications.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel p-5">
      <p className="eyebrow">Notification preferences</p>

      {status === 'checking' ? (
        <p className="hint mt-2">Checking this device…</p>
      ) : status === 'unsupported' ? (
        <p className="hint mt-2">Push notifications aren't supported in this browser.</p>
      ) : status === 'denied' ? (
        <p className="hint mt-2">
          Notifications are blocked for this site in your browser settings. Allow notifications for ShiftSync there,
          then reload this page to turn them on here.
        </p>
      ) : status === 'subscribed' ? (
        <>
          <p className="mt-2 flex items-center gap-2 text-sm text-success">
            <BellRing className="h-4 w-4 shrink-0" /> Push notifications are on for this device.
          </p>
          <button className="btn btn-ghost mt-3" onClick={() => void handleDisable()} disabled={busy}>
            <BellOff className="mr-1.5 inline h-3.5 w-3.5" /> {busy ? 'Turning off…' : 'Turn off'}
          </button>
        </>
      ) : (
        <>
          <p className="hint mt-2">
            Get notified on this device for things you need to act on — like a new Floor Plan section assignment.
          </p>
          <button className="btn btn-primary mt-3" onClick={() => void handleEnable()} disabled={busy}>
            <BellRing className="mr-1.5 inline h-3.5 w-3.5" /> {busy ? 'Enabling…' : 'Enable notifications'}
          </button>
        </>
      )}

      {error && (
        <div className="error-block mt-3" role="alert">
          <p>{error}</p>
        </div>
      )}
    </section>
  );
}
