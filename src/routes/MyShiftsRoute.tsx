import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useIdentity } from '../state/IdentityContext';
import { fetchMyShifts, ApiError, type MyShiftEntry } from '../api/myShifts';
import { fetchAvailability, setAvailability, removeAvailability, type AvailabilityMarkDto } from '../api/availability';
import { currentWeekStart } from '../engine/weekStart';
import { weekDates, weekdayOf } from '../engine/rosterView';
import { Announcements } from '../components/shiftsync/Announcements';
import { Shoutouts } from '../components/shiftsync/Shoutouts';
import { cn } from '../lib/utils';
import { useRefetchOnReturn } from '../lib/scheduleRefresh';

export default function MyShiftsContent() {
  const { session, logout } = useIdentity();
  const [pendingApproval, setPendingApproval] = useState(false);
  const [shifts, setShifts] = useState<MyShiftEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped when the person returns to the app or opens a notification, so a
  // manager's edit shows up without a reload (lib/scheduleRefresh.ts).
  const [refreshKey, setRefreshKey] = useState(0);
  useRefetchOnReturn(useCallback(() => setRefreshKey((k) => k + 1), []));

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
        // A 401 means the stored token is expired or was revoked. Clearing it
        // drops us into the not-signed-in state below, which offers a real way
        // back in — otherwise the user is stuck staring at an error with a
        // dead session they have no way to discard.
        if (err instanceof ApiError && err.status === 401) {
          logout();
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not load your shifts.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `logout` is stable for this provider's lifetime; re-running on it would
    // re-fetch pointlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, refreshKey]);

  if (!session) {
    return (
      <div className="status-block space-y-3">
        <p>You're not signed in. Sign in with your phone number to see your shifts.</p>
        <Link to="/join" className="btn btn-primary inline-flex">
          Join or log in
        </Link>
        <p className="text-xs text-muted-foreground">
          Setting up a brand-new venue?{' '}
          <Link to="/signup" className="underline-offset-2 hover:text-foreground hover:underline">
            Sign up your restaurant
          </Link>
        </p>
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
                {s.start}–{s.end}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AvailabilityWidget userId={session.user.id} token={session.token} />

      <Announcements />
      <Shoutouts />
    </div>
  );
}

/**
 * Self-service availability marking: a 7-day strip for the current week
 * where the signed-in staff member cycles each day through
 * unmarked → unavailable → preferred-off → unmarked. Backed by Task 6's
 * availability API, scoped to this user and the real current week via the
 * app's shared week-math helpers (`currentWeekStart`/`weekDates`) rather
 * than reinventing date arithmetic here.
 *
 * The reads are open (managers read other people's marks too), but every
 * write carries the session token — the server derives the owner from it and
 * ignores any userId a client might send. `userId` here is only for reading
 * this user's own marks back.
 */
function AvailabilityWidget({ userId, token }: { userId: string; token: string }) {
  const weekStart = currentWeekStart();
  const days = weekDates(weekStart);
  const [marks, setMarks] = useState<Record<string, AvailabilityMarkDto | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyDate, setBusyDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAvailability(token, userId, weekStart)
      .then((list) => {
        if (cancelled) return;
        setMarks(Object.fromEntries(list.map((m) => [m.date, m])));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load your availability.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, weekStart, token]);

  const cycle = async (date: string) => {
    const current = marks[date];
    setBusyDate(date);
    setError(null);
    try {
      if (!current) {
        // unmarked -> unavailable
        const created = await setAvailability(token, { date, type: 'UNAVAILABLE' });
        setMarks((prev) => ({ ...prev, [date]: created }));
      } else if (current.type === 'UNAVAILABLE') {
        // unavailable -> preferred off
        const updated = await setAvailability(token, { date, type: 'PREFERRED_OFF' });
        setMarks((prev) => ({ ...prev, [date]: updated }));
      } else {
        // preferred off -> unmarked
        await removeAvailability(token, current.id);
        setMarks((prev) => {
          const next = { ...prev };
          delete next[date];
          return next;
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that day.');
    } finally {
      setBusyDate(null);
    }
  };

  return (
    <section className="panel p-5">
      <h3 className="text-sm font-semibold">Your availability this week</h3>
      <p className="hint mt-1">Tap a day to cycle: unmarked → unavailable → preferred off → unmarked.</p>

      {error && (
        <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>
      )}

      {loading ? (
        <p className="hint mt-3">Loading…</p>
      ) : (
        <div className="mt-3 grid grid-cols-7 gap-1.5">
          {days.map((date) => {
            const mark = marks[date];
            const state: 'UNAVAILABLE' | 'PREFERRED_OFF' | 'UNMARKED' = mark?.type ?? 'UNMARKED';
            return (
              <button
                key={date}
                type="button"
                onClick={() => void cycle(date)}
                disabled={busyDate === date}
                aria-label={`${weekdayOf(date)} ${date} — ${state === 'UNAVAILABLE' ? 'unavailable' : state === 'PREFERRED_OFF' ? 'preferred off' : 'unmarked'}. Tap to change.`}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2 text-[11px] font-medium transition-colors disabled:opacity-50',
                  state === 'UNAVAILABLE' && 'border-destructive/30 bg-destructive/10 text-destructive',
                  state === 'PREFERRED_OFF' && 'border-warning/30 bg-warning/10 text-warning',
                  state === 'UNMARKED' && 'border-border text-muted-foreground hover:border-accent/40 hover:text-foreground',
                )}
              >
                <span className="uppercase tracking-wide">{weekdayOf(date)}</span>
                <span>{date.slice(8)}</span>
                <span className="text-[10px] normal-case">
                  {state === 'UNAVAILABLE' ? 'Unavailable' : state === 'PREFERRED_OFF' ? 'Prefer off' : '—'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
