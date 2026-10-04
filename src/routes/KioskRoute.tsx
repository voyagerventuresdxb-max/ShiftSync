import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Announcements } from '../components/shiftsync/Announcements';
import { Shoutouts } from '../components/shiftsync/Shoutouts';
import { fetchPublishStatus, fetchWeekShifts, type KioskShiftDto } from '../api/shifts';
import { ApiError } from '../api/schedules';
import { kioskTokenFromHash } from '../api/venueBinding';
import { weekdayOf } from '../engine/rosterView';
import { useAppState } from '../state/AppStateContext';
import { useIdentity } from '../state/IdentityContext';

type Board =
  | { status: 'loading' }
  | { status: 'refused'; message: string }
  | { status: 'ready'; shifts: KioskShiftDto[]; publishedAt: string | null };

const NO_LINK = 'This screen needs a current kiosk link — ask a manager to share it again.';

function formatDayMonth(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * `/kiosk?venue=<id>#k=<token>` — the venue's shared screen: this week's
 * published rota, announcements and shoutouts, no personal sign-in. The
 * link's venue and token are adopted into this device's binding
 * (api/venueBinding.ts) and the token is dropped from the address bar; every
 * read then sends it as `X-Kiosk-Token`. Without a current token the server
 * answers 401 and only that message shows. A signed-in visitor sees their
 * own venue's published rota instead (their session wins, as on Home).
 */
export default function KioskContent() {
  const { session } = useIdentity();
  const { locationId, readHeaders, weekStart, bindAnonymousVenue } = useAppState();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [board, setBoard] = useState<Board>({ status: 'loading' });
  const venueParam = searchParams.get('venue');

  useEffect(() => {
    const token = kioskTokenFromHash(location.hash);
    if (!session && venueParam) bindAnonymousVenue(venueParam, token);
    if (token) navigate({ search: location.search }, { replace: true });
  }, [session, venueParam, location.hash, location.search, bindAnonymousVenue, navigate]);

  useEffect(() => {
    if (!locationId) {
      // A link's `?venue=` is adopted by the effect above; until then there is nothing to read.
      if (!venueParam) setBoard({ status: 'refused', message: NO_LINK });
      return;
    }
    let cancelled = false;
    setBoard({ status: 'loading' });
    Promise.all([fetchWeekShifts(locationId, weekStart, readHeaders), fetchPublishStatus(locationId, weekStart, readHeaders)])
      .then(([shifts, publish]) => {
        if (cancelled) return;
        const published: KioskShiftDto[] = shifts.filter((s) => s.status === 'published');
        setBoard({ status: 'ready', shifts: published, publishedAt: publish.publishedAt });
      })
      .catch((err) => {
        if (!cancelled) setBoard({ status: 'refused', message: err instanceof ApiError ? err.message : 'Could not load the rota.' });
      });
    return () => {
      cancelled = true;
    };
  }, [locationId, weekStart, readHeaders, venueParam]);

  if (board.status === 'loading') return <p className="hint">Loading the rota…</p>;

  if (board.status === 'refused') {
    return (
      <section className="panel animate-rise p-4" role="alert" aria-labelledby="kiosk-refused-heading">
        <p className="eyebrow">Shared screen</p>
        <h2 id="kiosk-refused-heading" className="text-base font-semibold tracking-tight">
          Kiosk link needed
        </h2>
        <p className="hint mt-2">{board.message}</p>
      </section>
    );
  }

  const days = new Map<string, KioskShiftDto[]>();
  for (const s of board.shifts) days.set(s.date, [...(days.get(s.date) ?? []), s]);

  return (
    <div className="space-y-5">
      <section className="panel animate-rise p-4 sm:p-5" aria-labelledby="kiosk-rota-heading">
        <p className="eyebrow">Week of {formatDayMonth(weekStart)}</p>
        <h2 id="kiosk-rota-heading" className="text-base font-semibold tracking-tight">
          This week's rota
        </h2>
        {board.publishedAt && <p className="mt-1 text-xs text-muted-foreground">Published {formatStamp(board.publishedAt)}</p>}
        {days.size === 0 ? (
          <p className="hint mt-3">No published shifts this week yet.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {[...days].map(([date, shifts]) => (
              <div key={date}>
                <p className="eyebrow">
                  {weekdayOf(date)} {formatDayMonth(date)}
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {shifts.map((s) => (
                    <li key={s.id} className="flex items-baseline justify-between gap-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate font-medium">{s.employeeName ?? 'Open shift'}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {s.roleName} · {s.start}–{s.end}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
      <Announcements />
      <Shoutouts />
    </div>
  );
}
