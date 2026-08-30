import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, LayoutGrid } from 'lucide-react';
import { periodOf, shiftsFor, weekDates, weekdayOf } from '../engine/rosterView';
import { shiftHours } from '../engine/time';
import { nameKey } from '../engine/roleGrouping';
import { PersonalRota, type CoverCandidate, type RotaCard } from '../components/shiftsync/PersonalRota';
import { TeamMatrix, type MatrixCell, type MatrixMember } from '../components/shiftsync/TeamMatrix';
import { HourTracker } from '../components/shiftsync/HourTracker';
import { RotaBuilder } from '../components/shiftsync/RotaBuilder';
import ShiftUpload from '../components/ShiftUpload';
import { cn } from '../lib/utils';
import { useAppState } from '../state/AppStateContext';
import { clockIn, clockOut, fetchWeeklyHours } from '../api/attendance';
import { ApiError } from '../api/schedules';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type Mode = 'personal' | 'matrix';

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

function formatDayMonth(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const WEEK_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function SchedulingContent() {
  const {
    weekStart,
    setWeekStart,
    mergedRoster,
    config,
    currentEmployeeId,
    setCurrentEmployeeId,
    handleRequestCover,
    sections,
    collapsed,
    setCollapsed,
    handleCommitted,
    staffDirectoryByName,
    swapRequests,
  } = useAppState();

  const [searchParams, setSearchParams] = useSearchParams();

  // `weekStart` lives in AppStateContext, which sits ABOVE the router
  // (mounted in App.tsx wrapping <RouterProvider>), so it can't read the URL
  // itself — this component, which IS inside the router, is what reconciles
  // the two. Read once on mount: a `?week=` param (a hard refresh, or a
  // shared/bookmarked link) overrides the context's `currentWeekStart()`
  // default.
  useEffect(() => {
    const param = searchParams.get('week');
    if (param && WEEK_PARAM_RE.test(param) && param !== weekStart) {
      setWeekStart(param);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps the URL's `?week=` in sync with whatever week is actually on
  // screen — Prev/Next-week clicks, template application, etc. — so a hard
  // refresh always reloads the week that was really being viewed instead of
  // snapping back to `currentWeekStart()`. `replace` so paging through weeks
  // doesn't spam browser history with a back-button entry per week.
  //
  // Deliberately skips its very first invocation (`isFirstRunRef`). Both this
  // effect and the mount-only one above run in the SAME initial effects
  // flush, in definition order — but a state update from the first effect
  // (`setWeekStart`) doesn't land in this effect's closure until a later
  // render, so on that first pass `weekStart` here is still the stale
  // pre-mount-sync default. Without the skip, this effect would immediately
  // overwrite a valid incoming `?week=param` with that stale default,
  // fighting the mount effect above (self-corrects on the next render once
  // `weekStart` actually changes, but leaves a real window where the URL is
  // briefly wrong, and an async `setSearchParams` navigation resolving
  // out of order could leave it stuck wrong instead of just flickering).
  // Reconciling the initial URL/state mismatch is the mount effect's job
  // alone; this effect's job starts only once that's already settled.
  const isFirstRunRef = useRef(true);
  useEffect(() => {
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      return;
    }
    if (searchParams.get('week') !== weekStart) {
      const next = new URLSearchParams(searchParams);
      next.set('week', weekStart);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  const [mode, setMode] = useState<Mode>('personal');
  const activeEmployee =
    mergedRoster.employees.find((e) => e.id === currentEmployeeId) ?? mergedRoster.employees[0];

  const dates = useMemo(() => weekDates(mergedRoster.weekStart), [mergedRoster.weekStart]);

  // The rota builder's prev/next-week buttons move `weekStart`, which silently
  // retargets the hours panel too — so it has to say which week it is showing,
  // or a future week's 0.0h everywhere reads as a broken fetch.
  const weekLabel = `${formatDayMonth(dates[0]!)} – ${formatDayMonth(dates[6]!)}`;

  const rotaCards: RotaCard[] = useMemo(() => {
    if (!activeEmployee) return [];
    const shifts = shiftsFor(mergedRoster, activeEmployee.id);
    return dates.map((date) => {
      const dayShifts = shifts.filter((s) => s.date === date);
      if (dayShifts.length === 0) {
        return {
          id: `${activeEmployee.id}-${date}`,
          day: weekdayOf(date),
          date: formatDayMonth(date),
          venue: '',
          role: 'Rest day',
          start: '—',
          end: '—',
          hours: 0,
          status: 'off',
        };
      }
      const isPendingSwap = swapRequests.some((r) => r.shiftId === dayShifts[0].id && r.status === 'pending');
      // A day's card summarises every shift on it, so ANY unpublished shift
      // makes the whole card provisional. Upload-committed shifts carry no
      // `status` at all — those stay 'confirmed', exactly as before.
      const isDraft = dayShifts.some((s) => s.status === 'draft');
      return {
        id: dayShifts[0].id,
        day: weekdayOf(date),
        date: formatDayMonth(date),
        venue: config.name,
        role: dayShifts[0].requiredRole ?? activeEmployee.role,
        start: dayShifts.map((s) => s.start).join(' / '),
        end: dayShifts.map((s) => s.end).join(' / '),
        hours: dayShifts.reduce((sum, s) => sum + shiftHours(s.start, s.end), 0),
        // Draft outranks swap-pending: an unpublished line can still move or
        // vanish entirely, so "this isn't live yet" is the more urgent signal —
        // approving a cover for a shift that was never published is premature.
        status: isDraft ? 'draft' : isPendingSwap ? 'swap-pending' : 'confirmed',
        briefingNote: dayShifts[0].briefingNote,
        sidework: dayShifts[0].sidework,
      };
    });
  }, [mergedRoster, activeEmployee, dates, config.name, swapRequests]);

  const coverCandidates: CoverCandidate[] = activeEmployee
    ? mergedRoster.employees.filter((e) => e.id !== activeEmployee.id).map((e) => ({ id: e.id, name: e.name }))
    : [];

  const matrixDays = dates.map((d) => `${weekdayOf(d)} ${Number(d.slice(8, 10))}`);

  const matrixMembers: MatrixMember[] = mergedRoster.employees.map((e) => ({
    id: e.id,
    name: e.name,
    role: e.role,
    initials: initialsOf(e.name),
  }));

  const matrixCells: MatrixCell[][] = mergedRoster.employees.map((emp) => {
    const shifts = shiftsFor(mergedRoster, emp.id);
    return dates.map((date): MatrixCell => {
      const dayShifts = shifts.filter((s) => s.date === date);
      if (dayShifts.length === 0) return { code: 'OFF', kind: 'off' };
      if (dayShifts.length > 1) {
        const roles = [...new Set(dayShifts.map((s) => s.requiredRole).filter(Boolean))];
        const times = dayShifts.map((s) => `${s.start}–${s.end}`).join(', ');
        return { code: times, kind: 'double', requiredRole: roles.join(' + ') || undefined };
      }
      const s = dayShifts[0];
      const code = s.overnight ? `${s.start}–${s.end} +1` : `${s.start}–${s.end}`;
      return { code, kind: 'shift', requiredRole: s.requiredRole };
    });
  });

  const [hourStaff, setHourStaff] = useState<{ id: string; name: string; hours: number; contract: number }[]>([]);
  const [clockedIn, setClockedIn] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  const refreshHours = useCallback(() => {
    fetchWeeklyHours('seed-location', mergedRoster.weekStart)
      .then((entries) => {
        const byId = new Map(entries.map((e) => [e.id, e]));
        setHourStaff(
          mergedRoster.employees.map((emp) => ({
            id: emp.id,
            name: emp.name,
            hours: byId.get(emp.id)?.hours ?? 0,
            contract: config.compliance.maxWeeklyHours,
          })),
        );
        // Resync from server truth — not a local flip — so reloading the page
        // or switching the "Viewing" employee always reflects whether that
        // person actually has an open attendance log right now.
        setClockedIn(activeEmployee ? (byId.get(activeEmployee.id)?.clockedIn ?? false) : false);
      })
      .catch(() => setHourStaff([]));
  }, [mergedRoster.weekStart, mergedRoster.employees, config.compliance.maxWeeklyHours, activeEmployee]);

  useEffect(() => {
    refreshHours();
  }, [refreshHours]);

  const handleClockIn = () => {
    if (!activeEmployee) return;
    setClockError(null);
    clockIn(activeEmployee.id)
      .then(() => refreshHours())
      .catch((err) => setClockError(err instanceof ApiError ? err.message : 'Could not clock in.'));
  };
  const handleClockOut = () => {
    if (!activeEmployee) return;
    setClockError(null);
    clockOut(activeEmployee.id)
      .then(() => refreshHours())
      .catch((err) => setClockError(err instanceof ApiError ? err.message : 'Could not clock out.'));
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface p-1">
        {(
          [
            { id: 'personal', label: 'Personal Rota', icon: CalendarDays },
            { id: 'matrix', label: 'Team Matrix', icon: LayoutGrid },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setMode(t.id)}
            className={cn(
              'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-300',
              mode === t.id ? 'bg-accent text-accent-foreground shadow-lux' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {mode === 'personal' && mergedRoster.employees.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">Viewing</span>
              <select
                value={activeEmployee?.id}
                onChange={(e) => setCurrentEmployeeId(e.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground"
              >
                {mergedRoster.employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </div>
          )}

          <div key={mode} className="animate-rise">
            {mergedRoster.employees.length === 0 ? (
              <p className="panel p-5 text-sm text-muted-foreground">
                No staff parsed yet — upload a roster to see the personal and team views.
              </p>
            ) : mode === 'personal' ? (
              <PersonalRota shifts={rotaCards} coverCandidates={coverCandidates} onRequestCover={handleRequestCover} />
            ) : (
              <TeamMatrix venueName={config.name} days={matrixDays} members={matrixMembers} matrix={matrixCells} />
            )}
          </div>
        </div>

        <aside className="min-w-0 space-y-5">
          {clockError && (
            <div className="error-block" role="alert">
              <p>{clockError}</p>
            </div>
          )}
          <HourTracker
            staff={hourStaff}
            weekLabel={weekLabel}
            currentEmployeeName={activeEmployee?.name}
            clockedIn={clockedIn}
            onClockIn={handleClockIn}
            onClockOut={handleClockOut}
          />
        </aside>
      </div>

      <div className="mt-5">
        <RotaBuilder />
      </div>

      <div className="mt-5">
        <ShiftUpload locationId="seed-location" onCommitted={handleCommitted} />

        <section className="roster">
          <h2 className="section-title">Roster</h2>
          <div className="roster-table-grid">
            <div className="grid-head">
              <span className="cell head">Staff</span>
              {DAYS.map((d) => (
                <span className="cell head" key={d}>{d}</span>
              ))}
              <span className="cell head">Hours</span>
            </div>
            {sections.map((section) => {
              const isCollapsed = !!collapsed[section.key];
              return (
                <div className="roster-section" key={section.key}>
                  <button
                    className={`roster-section-head${section.flagged ? ' roster-section-head-warn' : ''}`}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [section.key]: !prev[section.key] }))}
                    aria-expanded={!isCollapsed}
                  >
                    <span className={`section-caret${isCollapsed ? ' collapsed' : ''}`}>▾</span>
                    <span className="section-label">{section.label}</span>
                    <span className="section-count">{section.employees.length}</span>
                  </button>
                  {!isCollapsed &&
                    section.employees.map((emp) => {
                      const empShifts = mergedRoster.shifts.filter((s) => s.employeeId === emp.id);
                      const total = empShifts.reduce((sum, s) => sum + shiftHours(s.start, s.end), 0);
                      return (
                        <div className="grid-row" key={emp.id}>
                          <span className="cell name">
                            {emp.name}
                            <span className="role">{staffDirectoryByName.get(nameKey(emp.name))?.jobTitle || emp.role}</span>
                            {emp.needsRoleReview && (
                              <span className="badge badge-warn" title="This shift is not saved. Fix the role in the source file (or add it to the Staff Directory) and re-upload.">
                                ⚠ Not saved — role unresolved
                              </span>
                            )}
                          </span>
                          {DAYS.map((d) => {
                            const dayShifts = empShifts.filter((s) => weekdayOf(s.date) === d);
                            return (
                              <span className={`cell shift ${dayShifts[0]?.type ?? ''}`} key={d}>
                                {dayShifts.length > 1 ? (
                                  <span className="split">
                                    {dayShifts.map((s) => (
                                      <span key={s.id}><span className="period">{periodOf(s)}</span>{s.start}-{s.end}</span>
                                    ))}
                                  </span>
                                ) : dayShifts.length === 1 ? (
                                  `${dayShifts[0].start}-${dayShifts[0].end}`
                                ) : (
                                  ''
                                )}
                              </span>
                            );
                          })}
                          <span className="cell hours">{total.toFixed(1)}h</span>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </>
  );
}
