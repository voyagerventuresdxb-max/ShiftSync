import { useEffect, useState } from 'react';
import { useIdentity } from '../state/IdentityContext';
import { fetchMyShifts, ApiError, type MyShiftEntry } from '../api/myShifts';
import { fetchAvailability, setAvailability, removeAvailability, type AvailabilityMarkDto } from '../api/availability';
import { currentWeekStart } from '../engine/weekStart';
import { weekDates, weekdayOf } from '../engine/rosterView';
import { Announcements } from '../components/shiftsync/Announcements';
import { Shoutouts } from '../components/shiftsync/Shoutouts';
import { cn } from '../lib/utils';

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

      <AvailabilityWidget userId={session.user.id} />

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
 */
function AvailabilityWidget({ userId }: { userId: string }) {
  const weekStart = currentWeekStart();
  const days = weekDates(weekStart);
  const [marks, setMarks] = useState<Record<string, AvailabilityMarkDto | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyDate, setBusyDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAvailability(userId, weekStart)
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
  }, [userId, weekStart]);

  const cycle = async (date: string) => {
    const current = marks[date];
    setBusyDate(date);
    setError(null);
    try {
      if (!current) {
        // unmarked -> unavailable
        const created = await setAvailability({ userId, date, type: 'UNAVAILABLE' });
        setMarks((prev) => ({ ...prev, [date]: created }));
      } else if (current.type === 'UNAVAILABLE') {
        // unavailable -> preferred off
        const updated = await setAvailability({ userId, date, type: 'PREFERRED_OFF' });
        setMarks((prev) => ({ ...prev, [date]: updated }));
      } else {
        // preferred off -> unmarked
        await removeAvailability(current.id);
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
                <span className="text-[9px] normal-case">
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
