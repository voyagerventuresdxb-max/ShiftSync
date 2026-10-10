import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, LayoutGrid } from 'lucide-react';
import { pickViewedEmployee } from '../engine/rosterView';
import { HourTracker } from '../components/shiftsync/HourTracker';
import { PanelSkeleton } from '../components/shiftsync/PanelSkeleton';
import { cn } from '../lib/utils';
import { offlineLabel } from '../lib/offlineCache';
import { useAppState } from '../state/AppStateContext';
import { useIdentity } from '../state/IdentityContext';
import { useConnectivity } from '../state/ConnectivityContext';
import { useWeekDoc } from '../state/useWeekDoc';
import { clockIn, clockOut, fetchWeeklyHours } from '../api/attendance';
import { ApiError } from '../api/schedules';
import { emitRosterChanged } from '../api/weeks';
import { reconcileWeekParam } from '../engine/weekStart';
import { StaffWeek } from '../components/rota/staff/StaffWeek';
import { WeekMatrix } from '../components/rota/staff/WeekMatrix';
import { useMediaQuery } from '../components/rota/useMediaQuery';
import type { WeekDocDto } from '../../shared/rotaWeek';

// Manager-only (their writes are manager-only on the server too) and the
// heaviest parts of this screen: loaded only for a manager or owner, so staff
// opening their rota never download them — dnd-kit lives behind these.
const WeekBuilder = lazy(() => import('../components/rota/WeekBuilder'));
const ManagerPhoneRota = lazy(() => import('../components/rota/phone/ManagerPhoneRota').then((m) => ({ default: m.ManagerPhoneRota })));
const ShiftUpload = lazy(() => import('../components/ShiftUpload'));

type Mode = 'mine' | 'matrix';

/**
 * Team Matrix from the same week document the grid uses (Design board E), so
 * the two can never disagree. Staff get published rows from the server; a
 * manager's doc also holds drafts, so it is filtered to what staff see.
 */
function TeamMatrixView({ locationId, weekStart }: { locationId: string; weekStart: string }) {
  const { session } = useIdentity();
  const doc = useWeekDoc({ locationId, weekStart, sessionToken: session?.token ?? null, offlineUserId: session?.user.id ?? null });
  const week = useMemo<WeekDocDto | null>(
    () => (doc.week ? { ...doc.week, shifts: doc.week.shifts.filter((s) => s.status === 'published'), leaves: doc.week.leaves.filter((l) => l.status === 'published') } : null),
    [doc.week],
  );
  if (!week) {
    return doc.error ? (
      <div className="error-block" role="alert">
        <p>{doc.error}</p>
        <button type="button" className="btn btn-ghost" onClick={() => void doc.refetch()}>
          Retry
        </button>
      </div>
    ) : (
      <PanelSkeleton rows={5} />
    );
  }
  return (
    <>
      {doc.offlineSince && (
        <p role="status" data-testid="offline-label" className="pb-2 text-[11px] text-warning">
          {offlineLabel(doc.offlineSince)} — the published rota as you last saw it.
        </p>
      )}
      <WeekMatrix week={week} />
    </>
  );
}

export default function SchedulingContent() {
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const { locationId, weekStart, setWeekStart, mergedRoster, currentEmployeeId, setCurrentEmployeeId, handleCommitted } = useAppState();

  const [searchParams, setSearchParams] = useSearchParams();

  // `weekStart` lives in AppStateContext, which sits ABOVE the router
  // (mounted in App.tsx wrapping <RouterProvider>), so it can't read the URL
  // itself — this component, which IS inside the router, reconciles the two
  // in both directions in one effect: an incoming `?week=` that differs from
  // state (hard refresh, a shared link, a remount with a bare URL) is adopted
  // into state and the effect returns without also writing the URL in the
  // same pass; otherwise whatever `weekStart` is gets written back to the URL
  // (`replace`, so paging weeks doesn't spam history). `lastSyncedWeek` tells
  // a week switch (state moved) apart from back/forward (URL moved); the
  // decision lives in engine/weekStart.ts (unit-tested). A non-Monday
  // `?week=` is adopted as its Monday.
  const lastSyncedWeek = useRef<string | null>(null);
  useEffect(() => {
    const { adopt, write, lastSynced } = reconcileWeekParam(searchParams.get('week'), weekStart, lastSyncedWeek.current);
    lastSyncedWeek.current = lastSynced;
    if (adopt) setWeekStart(adopt);
    if (write) {
      const next = new URLSearchParams(searchParams);
      next.set('week', write);
      setSearchParams(next, { replace: true });
    }
  }, [weekStart, searchParams, setWeekStart, setSearchParams]);

  const isStaffSession = session?.user.systemRole === 'STAFF';
  const isManagerSession = session?.user.systemRole === 'MANAGER' || session?.user.systemRole === 'OWNER';
  const [mode, setMode] = useState<Mode>('mine');
  // Phone mode below 768 px (Spec §1); the builder is tablet / desktop only.
  const wide = useMediaQuery('(min-width: 768px)');

  // --- Clock in / out (attendance; no hours totals on rota surfaces) ---
  // A STAFF session can only ever clock ITSELF in/out server-side, so its
  // target is always its own identity; a manager clocks someone in on their
  // behalf, picked below.
  const activeEmployee = pickViewedEmployee(mergedRoster.employees, currentEmployeeId, session?.user ?? null);
  const clockTargetId = isStaffSession ? session!.user.id : activeEmployee?.id;
  const clockTargetName = isStaffSession ? session!.user.fullName : activeEmployee?.name;
  const [clockedIn, setClockedIn] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  const refreshClock = useCallback(() => {
    if (!locationId || !session || !clockTargetId) {
      setClockedIn(false);
      return;
    }
    // Resync from server truth — not a local flip — so a reload or a change of
    // target always reflects whether that person has an open attendance log.
    fetchWeeklyHours(session.token, locationId, weekStart)
      .then((entries) => setClockedIn(entries.find((e) => e.id === clockTargetId)?.clockedIn ?? false))
      .catch(() => setClockedIn(false));
  }, [locationId, session, clockTargetId, weekStart]);

  useEffect(() => {
    refreshClock();
  }, [refreshClock]);

  const handleClock = (action: 'in' | 'out') => {
    // Blocked outright while offline: a clock-in that lands later than the
    // real moment is a payroll problem — no auto-retry.
    if (!clockTargetId || !session || !online) return;
    setClockError(null);
    (action === 'in' ? clockIn(session.token, clockTargetId) : clockOut(session.token, clockTargetId))
      .then(() => refreshClock())
      .catch((err) => setClockError(err instanceof ApiError ? err.message : `Could not clock ${action}.`));
  };

  // A roster import writes the week server-side: every rota surface refetches.
  const onImported = useCallback(
    (...args: Parameters<typeof handleCommitted>) => {
      handleCommitted(...args);
      if (!locationId) return;
      const imported = args[3];
      const weeks = new Set([weekStart, ...(imported ? [imported] : [])]);
      // The new version is not known here; the largest one makes every listener refetch.
      for (const ws of weeks) emitRosterChanged({ locationId, weekStart: ws, version: Number.MAX_SAFE_INTEGER });
    },
    [handleCommitted, locationId, weekStart],
  );

  const clockPanel = (
    <>
      {clockError && (
        <div className="error-block" role="alert">
          <p>{clockError}</p>
        </div>
      )}
      <HourTracker
        currentEmployeeName={clockTargetName}
        clockedIn={clockedIn}
        onClockIn={clockTargetId ? () => handleClock('in') : undefined}
        onClockOut={clockTargetId ? () => handleClock('out') : undefined}
        online={online}
        targetPicker={
          isManagerSession && mergedRoster.employees.length > 0 ? (
            <label className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">Clock for</span>
              <select value={activeEmployee?.id} onChange={(e) => setCurrentEmployeeId(e.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-2 text-sm text-foreground">
                {mergedRoster.employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
      />
    </>
  );

  const tabs = (
    <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface p-1">
      {(
        [
          { id: 'mine', label: isManagerSession ? 'Rota builder' : 'My week', icon: CalendarDays },
          { id: 'matrix', label: 'Team Matrix', icon: LayoutGrid },
        ] as const
      ).map((t) => (
        <button
          key={t.id}
          onClick={() => setMode(t.id)}
          aria-pressed={mode === t.id}
          className={cn(
            'hit-44 inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-300',
            mode === t.id ? 'bg-accent text-accent-foreground shadow-lux' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <t.icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{t.label}</span>
        </button>
      ))}
    </div>
  );

  if (!locationId) return <PanelSkeleton rows={4} />;

  if (isManagerSession) {
    return (
      <>
        {tabs}
        <div className="mt-5">
          {mode === 'matrix' ? (
            <TeamMatrixView locationId={locationId} weekStart={weekStart} />
          ) : (
            <Suspense fallback={<PanelSkeleton rows={6} />}>
              {wide ? <WeekBuilder locationId={locationId} weekStart={weekStart} onWeekChange={setWeekStart} /> : <ManagerPhoneRota locationId={locationId} weekStart={weekStart} onWeekChange={setWeekStart} />}
            </Suspense>
          )}
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div id="roster-import" className="min-w-0 scroll-mt-20">
            <Suspense fallback={<PanelSkeleton />}>
              <ShiftUpload onCommitted={onImported} />
            </Suspense>
          </div>
          <aside className="min-w-0 space-y-5">{clockPanel}</aside>
        </div>
      </>
    );
  }

  return (
    <>
      {tabs}
      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div key={mode} className="min-w-0 animate-rise">
          {mode === 'mine' ? <StaffWeek locationId={locationId} weekStart={weekStart} onWeekChange={setWeekStart} /> : <TeamMatrixView locationId={locationId} weekStart={weekStart} />}
        </div>
        <aside className="min-w-0 space-y-5">{clockPanel}</aside>
      </div>
    </>
  );
}
