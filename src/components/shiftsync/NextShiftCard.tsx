import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { useMyShifts } from '../../state/useMyShifts';
import { offlineLabel } from '../../lib/offlineCache';
import { ShiftLine } from '../rota/staff/MyShiftLine';

/**
 * Home's "Your next shift" for a signed-in staff member; shows the offline copy, labelled, when the network is down.
 * With a v2 server it also names the shift type, shows both parts of a split, "+1" for a cross-midnight end and the note.
 */
export function NextShiftCard() {
  const { shifts, loading, error, offlineSince } = useMyShifts();
  const next = shifts[0];

  return (
    <section className="panel p-4 sm:p-5" data-testid="next-shift-card">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10">
          <CalendarClock className="h-4 w-4 text-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Your next shift</p>
          {offlineSince && (
            <p role="status" data-testid="offline-label" className="mt-1 text-xs text-warning">
              {offlineLabel(offlineSince)}
            </p>
          )}
          {loading ? (
            <p className="hint mt-1">Loading…</p>
          ) : error ? (
            <p className="hint mt-1">{error}</p>
          ) : next ? (
            <ShiftLine shift={next} testId="next-shift-time" className="mt-1 text-sm" />
          ) : (
            <p className="hint mt-1">No upcoming shifts scheduled yet.</p>
          )}
          <Link to="/my-shifts" className="hit-44 mt-2 inline-block text-xs text-accent underline-offset-2 hover:underline">
            All my shifts
          </Link>
        </div>
      </div>
    </section>
  );
}
