import { useEffect, useState } from 'react';
import { useIdentity } from '../state/IdentityContext';
import { fetchMyShifts, ApiError, type MyShiftEntry } from '../api/myShifts';
import { Announcements } from '../components/shiftsync/Announcements';
import { Shoutouts } from '../components/shiftsync/Shoutouts';

export default function MyShiftsContent() {
  const { session } = useIdentity();
  const [pendingApproval, setPendingApproval] = useState(false);
  const [shifts, setShifts] = useState<MyShiftEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchMyShifts(session.token)
      .then((data) => {
        if (cancelled) return;
        setPendingApproval(data.pendingApproval);
        setShifts(data.shifts);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load your shifts.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session) {
    return (
      <div className="status-block">
        <p>You're not signed in. Head to Join or log in with your phone number to see your shifts.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h2 className="section-title">Welcome back, {session.user.fullName}</h2>

      {pendingApproval && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          Your account is still pending manager approval — some things may look incomplete until then.
        </div>
      )}

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      <section className="panel p-5">
        <h3 className="text-sm font-semibold">Your next shifts</h3>
        {loading ? (
          <p className="hint">Loading…</p>
        ) : shifts.length === 0 ? (
          <p className="hint">No upcoming shifts scheduled yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {shifts.map((s) => (
              <li key={s.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                <span className="font-medium">{s.date}</span> · {s.roleName} ·{' '}
                {new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–
                {new Date(s.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Announcements />
      <Shoutouts />
    </div>
  );
}
