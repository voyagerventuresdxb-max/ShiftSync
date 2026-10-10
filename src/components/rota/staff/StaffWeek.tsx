import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, CalendarX, ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, weekDays, type WeekShiftDto } from '../../../../shared/rotaWeek';
import { useWeekDoc } from '../../../state/useWeekDoc';
import { useIdentity } from '../../../state/IdentityContext';
import { useConnectivity } from '../../../state/ConnectivityContext';
import { offlineLabel } from '../../../lib/offlineCache';
import { cn } from '../../../lib/utils';
import { ShiftChip, StatusChip } from '../chips';
import { changedDates, daySignatures, loadSeen, saveSeen, seenKey, type SeenWeek } from './changedBadge';
import { formatDuration, nowAndNext, staffDays, swappableShifts } from './staffWeekModel';
import { dayOfMonth, formatStamp, longDate, shortWeekday, venueNow, weekRangeLabel } from './weekModel';

// The request sheets are only needed once someone taps a button: kept out of the staff bundle.
const TimeOffSheet = lazy(() => import('./StaffRequestSheets').then((m) => ({ default: m.TimeOffSheet })));
const SwapSheet = lazy(() => import('./StaffRequestSheets').then((m) => ({ default: m.SwapSheet })));

/**
 * Staff "My week" (Design board B7): only what the manager has published
 * (the server returns the published view for a staff session), the shift on
 * now or next, off days and leave, pending requests, and a "Changed" badge on
 * days that moved since this device last showed them. Entry points to
 * request time off and to swap a shift. Mounted by the Scheduling tab for
 * staff at every width (centred at 480 px on larger screens).
 */
export interface StaffWeekProps {
  locationId: string;
  weekStart: string;
  onWeekChange: (weekStart: string) => void;
}

export function StaffWeek(props: StaffWeekProps) {
  const { locationId, weekStart, onWeekChange } = props;
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const userId = session?.user.id ?? null;
  const { week, loading, error, offlineSince, refetch } = useWeekDoc({
    locationId,
    weekStart,
    sessionToken: session?.token ?? null,
    offlineUserId: userId,
  });
  const [sheet, setSheet] = useState<'timeOff' | 'swap' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A minute tick keeps "on shift now" and "ends in" honest while the screen stays open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const now = venueNow(week?.timezone ?? 'UTC');

  const days = useMemo(() => (week && userId ? staffDays(week, userId, now.date) : []), [week, userId, now.date]);
  const { current, next } = nowAndNext(
    days.flatMap((d) => d.shifts),
    now,
  );

  // "Changed" badge: compare with what this device last showed, then record what it shows now.
  const baseline = useRef<{ key: string; seen: SeenWeek | null } | null>(null);
  const key = userId ? seenKey(userId, locationId, weekStart) : null;
  const signatures = useMemo(() => (week && userId && week.weekStart === weekStart ? daySignatures(week, userId) : null), [week, userId, weekStart]);
  if (key && signatures && baseline.current?.key !== key) baseline.current = { key, seen: loadSeen(key) };
  const changed = useMemo(() => (signatures && baseline.current?.key === key ? changedDates(baseline.current.seen, signatures) : new Set<string>()), [signatures, key]);
  useEffect(() => {
    // Only a live copy counts as "seen": the offline snapshot may be older than what the device last showed.
    if (key && signatures && !offlineSince) saveSeen(key, { publishedVersion: week?.publishedVersion ?? null, days: signatures });
  }, [key, signatures, offlineSince, week?.publishedVersion]);

  const me = week?.people.find((p) => p.id === userId) ?? null;
  const myDept = me ? week?.departments.find((d) => d.id === me.departmentId)?.name : null;
  const colleagues = useMemo(() => {
    if (!week || !me) return [];
    return week.people
      .filter((p) => p.id !== me.id && p.isActive)
      .sort((a, b) => Number(b.departmentId === me.departmentId) - Number(a.departmentId === me.departmentId) || a.fullName.localeCompare(b.fullName));
  }, [week, me]);

  const list = weekDays(weekStart);
  const chipShift = (s: WeekShiftDto): WeekShiftDto => ({ ...s, editedSincePublish: false, status: 'published' });

  if (!session) return <p className="panel p-5 text-sm text-muted-foreground">Sign in to see your week.</p>;

  return (
    <section className="mx-auto flex w-full max-w-[480px] flex-col gap-3" aria-label="My week" data-testid="staff-week">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="eyebrow truncate">{myDept ?? 'My rota'}</span>
          <h2 className="font-['Instrument_Serif',ui-serif,Georgia,serif] text-[28px] font-normal leading-[1.05]">My week</h2>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 text-[13px] font-semibold tabular-nums">
          <button type="button" onClick={() => onWeekChange(addDays(weekStart, -7))} aria-label="Previous week" className="grid h-11 w-11 place-items-center rounded-full text-muted-foreground hover:text-foreground">
            <ChevronLeft aria-hidden="true" className="h-5 w-5" />
          </button>
          <span>{weekRangeLabel(list[0]!, list[6]!)}</span>
          <button type="button" onClick={() => onWeekChange(addDays(weekStart, 7))} aria-label="Next week" className="grid h-11 w-11 place-items-center rounded-full text-muted-foreground hover:text-foreground">
            <ChevronRight aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
      </div>

      {offlineSince && (
        <p role="status" data-testid="offline-label" className="text-[11px] text-warning">
          {offlineLabel(offlineSince)} — the published rota as you last saw it.
        </p>
      )}

      {week && (current || next) && (
        <div className="flex flex-col gap-1 rounded-2xl border border-accent/50 bg-surface-raised px-4 py-3.5 shadow-glow">
          <span className="eyebrow text-accent">{current ? 'On shift now' : 'Next shift'}</span>
          {(() => {
            const s = (current ?? next)!.shift;
            const name = week.shiftTypes.find((t) => t.id === s.shiftTypeId)?.name ?? 'Shift';
            const times = s.ranges.map((r) => `${r.start} – ${r.end}`).join(' · ');
            const when = current
              ? `ends in ${formatDuration(current.endsIn)}`
              : next && next.startsIn < 24 * 60
                ? `starts in ${formatDuration(next.startsIn)}`
                : `starts at ${s.ranges[0]?.start ?? ''}`;
            return (
              <>
                <span className="font-['Instrument_Serif',ui-serif,Georgia,serif] text-[26px] leading-tight tabular-nums">
                  {name} · {times}
                  {s.endsNextDay && <span className="rota-next-day ml-1.5 align-middle font-sans text-[10px]">+1</span>}
                </span>
                <span className="text-[13px] text-muted-foreground">
                  {longDate(s.date)} · {when}
                </span>
                {s.note && <span className="text-[13px] text-foreground/87">{s.note}</span>}
              </>
            );
          })()}
        </div>
      )}

      {loading && !week ? (
        <div className="flex flex-col" aria-busy="true" aria-label="Loading your week">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="grid min-h-16 grid-cols-[56px_minmax(0,1fr)] items-center gap-3 border-b border-border">
              <div className="h-8 w-8 animate-pulse rounded bg-muted" />
              <div className="h-12 animate-pulse rounded-xl bg-muted" />
            </div>
          ))}
        </div>
      ) : error && !week ? (
        <div className="error-block" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void refetch()} className="mt-2 min-h-11 rounded-xl border border-border-strong px-4 text-sm font-semibold">
            Try again
          </button>
        </div>
      ) : week ? (
        <div className="flex flex-col">
          {days.map((d) => {
            const isNext = !current && next?.shift.date === d.date && d.shifts.some((s) => s.id === next.shift.id);
            const isNow = current?.shift.date === d.date;
            const isChanged = changed.has(d.date);
            const pills = [
              d.today ? 'Today' : null,
              isChanged ? 'Changed' : null,
              d.offRequested ? 'Off requested · pending' : null,
              d.swapRequested ? 'Swap requested · pending' : null,
              isNext ? 'Next shift' : null,
            ].filter((x): x is string => x !== null);
            const spoken = d.shifts.length
              ? d.shifts
                  .map(
                    (s) =>
                      `${longDate(d.date)}, ${week.shiftTypes.find((t) => t.id === s.shiftTypeId)?.name ?? 'Shift'} ${s.ranges.map((r) => `${r.start} to ${r.end}`).join(' and ')}${s.endsNextDay ? ', ends next day' : ''}${s.note ? `, note: ${s.note}` : ''}`,
                  )
                  .join('; ')
              : `${longDate(d.date)}, ${d.leave === 'ANNUAL_LEAVE' ? 'annual leave' : d.leave === 'SICK_LEAVE' ? 'sick' : d.leave === 'UNPAID_LEAVE' ? 'unpaid leave' : d.leave === 'HALF_DAY' ? 'half day' : 'day off'}`;
            return (
              <div
                key={d.date}
                aria-label={[spoken, ...pills.map((p) => p.toLowerCase())].join(', ')}
                role="group"
                className={cn(
                  'grid min-h-16 grid-cols-[56px_minmax(0,1fr)] items-center gap-3 border-b border-border py-1.5',
                  (isNext || isNow) && '-mx-4 bg-accent/8 px-4',
                  d.past && !d.today && 'opacity-60',
                )}
              >
                <span aria-hidden="true" className="flex flex-col leading-tight">
                  <span className={cn('text-[11px] font-bold uppercase tracking-[0.08em]', isNext || isNow ? 'text-accent' : 'text-muted-foreground')}>{shortWeekday(d.date)}</span>
                  <span className={cn('text-xl font-semibold tabular-nums', (isNext || isNow) && 'text-accent')}>{dayOfMonth(d.date)}</span>
                </span>
                <div aria-hidden="true" className="flex min-w-0 flex-col gap-1">
                  {d.shifts.length > 0 ? (
                    d.shifts.map((s) => <ShiftChip key={s.id} shift={chipShift(s)} types={week.shiftTypes} clock={week.clock} className={cn(d.today && 'ring-1 ring-accent/50')} />)
                  ) : d.leave ? (
                    <StatusChip type={d.leave} />
                  ) : d.offRequested ? (
                    <StatusChip type="OFF_REQUESTED" />
                  ) : (
                    <StatusChip type="DAY_OFF" />
                  )}
                  {d.shifts.map((s) => s.note).filter(Boolean).length > 0 && (
                    <span className="truncate text-xs text-foreground/80">{d.shifts.map((s) => s.note).filter(Boolean).join(' · ')}</span>
                  )}
                  {pills.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {pills.map((p) => (
                        <span
                          key={p}
                          className={cn(
                            'whitespace-nowrap rounded-full border px-[7px] py-0.5 text-[10px] font-bold uppercase tracking-[0.06em]',
                            p === 'Changed' ? 'border-accent/60 bg-accent/12 text-accent' : p.endsWith('pending') ? '' : 'border-border-strong text-muted-foreground',
                          )}
                          style={p.endsWith('pending') ? { color: 'var(--rota-ochre)', borderColor: 'color-mix(in oklab, var(--rota-ochre) 55%, transparent)' } : undefined}
                        >
                          {p}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {week && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {week.publishedAt ? `Published ${formatStamp(week.publishedAt, week.timezone)} · only what your manager has published.` : 'Nothing published for this week yet · only what your manager has published shows here.'}
          {changed.size > 0 && ' “Changed” = moved since you last looked.'}
        </p>
      )}

      {notice && (
        <p role="status" className="rounded-xl border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
          {notice}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSheet('timeOff')}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-border-strong bg-surface-raised px-3 text-sm font-semibold"
        >
          <CalendarX aria-hidden="true" className="h-[18px] w-[18px]" />
          Request time off
        </button>
        <button
          type="button"
          disabled={!week}
          onClick={() => setSheet('swap')}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-border-strong bg-surface-raised px-3 text-sm font-semibold disabled:opacity-50"
        >
          <ArrowLeftRight aria-hidden="true" className="h-[18px] w-[18px]" />
          Swap a shift
        </button>
      </div>

      <Suspense fallback={null}>
        {sheet === 'timeOff' && (
          <TimeOffSheet
            token={session.token}
            today={now.date}
            initialDate={list.find((d) => d >= now.date) ?? addDays(now.date, 1)}
            online={online}
            onClose={() => setSheet(null)}
            onDone={(m) => {
              setSheet(null);
              setNotice(m);
              void refetch();
            }}
          />
        )}
        {sheet === 'swap' && week && (
          <SwapSheet
            token={session.token}
            shifts={swappableShifts(days, now)}
            types={week.shiftTypes}
            clock={week.clock}
            colleagues={colleagues}
            online={online}
            onClose={() => setSheet(null)}
            onDone={(m) => {
              setSheet(null);
              setNotice(m);
              void refetch();
            }}
          />
        )}
      </Suspense>
    </section>
  );
}
