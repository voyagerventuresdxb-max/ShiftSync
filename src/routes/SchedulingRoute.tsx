import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, LayoutGrid } from 'lucide-react';
import { periodOf, pickViewedEmployee, shiftsFor, weekDates, weekdayOf } from '../engine/rosterView';
import { shiftHours } from '../engine/time';
import { reconcileWeekParam } from '../engine/weekStart';
import { nameKey } from '../engine/roleGrouping';
import { PersonalRota, type CoverCandidate, type RotaCard } from '../components/shiftsync/PersonalRota';
import { TeamMatrix, type MatrixCell, type MatrixMember } from '../components/shiftsync/TeamMatrix';
import { HourTracker } from '../components/shiftsync/HourTracker';
import { RotaBuilder } from '../components/shiftsync/RotaBuilder';
import ShiftUpload from '../components/ShiftUpload';
import { cn } from '../lib/utils';
import { useAppState } from '../state/AppStateContext';
import { useIdentity } from '../state/IdentityContext';
import { useConnectivity } from '../state/ConnectivityContext';
import { StaleDataNotice } from '../components/shiftsync/OfflineNotice';
import { clockIn, clockOut, fetchWeeklyHours } from '../api/attendance';
import { fetchMyAssignments, type MyAssignmentDto } from '../api/floorPlan';
import { ApiError } from '../api/schedules';
import { LEAVE_LABELS } from '../../shared/leaveTypes';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type Mode = 'personal' | 'matrix';

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

function formatDayMonth(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}


export default function SchedulingContent() {
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const {
    locationId,
    weekStart,
    setWeekStart,
    mergedRoster,
    initialScheduleLoading,
    scheduleLoadFailed,
    config,
    venueName,
    currentEmployeeId,
    setCurrentEmployeeId,
    handleRequestCover,
    sections,
    collapsed,
    setCollapsed,
    handleCommitted,
    staffDirectoryByName,
    swapRequests,
    weekLeaves,
  } = useAppState();

  const [searchParams, setSearchParams] = useSearchParams();

  // `weekStart` lives in AppStateContext, which sits ABOVE the router
  // (mounted in App.tsx wrapping <RouterProvider>), so it can't read the URL
  // itself — this component, which IS inside the router, reconciles the two.
  // The decision lives in engine/weekStart.ts's `reconcileWeekParam`
  // (unit-tested); `lastSyncedWeek` is the week both sides last agreed on,
  // which is how a Prev/Next click (state moved) is told apart from a
  // bookmark or back/forward (URL moved). `replace` so paging through weeks
  // doesn't add a history entry per week.
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

  const [mode, setMode] = useState<Mode>('personal');
  // Positive allowlist (fail-closed): builder/upload/"Viewing" controls render
  // only for the manager tier. The server enforces the same rule on every
  // write (requireManager); this just stops staff seeing controls that 403.
  const isManager = session?.user.systemRole === 'OWNER' || session?.user.systemRole === 'MANAGER';
  // A STAFF member opening Scheduling must land on THEIR OWN rota — the
  // "Viewing" dropdown used to default to whoever happened to be first on the
  // week's roster, so they saw a colleague's shifts (and a Request-cover
  // button that could only 404 for them). Managers keep the first-entry
  // default: for them this view is a team review, not a personal one.
  const activeEmployee = pickViewedEmployee(mergedRoster.employees, isManager ? currentEmployeeId : undefined, session?.user ?? null);

  const dates = useMemo(() => weekDates(mergedRoster.weekStart), [mergedRoster.weekStart]);

  // Floor Plan section assignments for the currently-viewed employee, across
  // this week — feeds PersonalRota's "You're covering: [section]" line.
  // PUBLISHED only (the endpoint itself never returns DRAFT rows).
  const [myAssignments, setMyAssignments] = useState<MyAssignmentDto[]>([]);
  useEffect(() => {
    if (!session || !locationId || !activeEmployee) {
      setMyAssignments([]);
      return;
    }
    let cancelled = false;
    fetchMyAssignments(session.token, locationId, activeEmployee.id, dates[0]!, dates[6]!)
      .then((list) => {
        if (!cancelled) setMyAssignments(list);
      })
      .catch(() => {
        // Personal Rota has no error slot for this today — a failed load
        // just means the "You're covering" line doesn't appear, same as
        // "no assignment yet" (nothing is contradicted or lost either way).
        if (!cancelled) setMyAssignments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session, locationId, activeEmployee, dates]);

  // The rota builder's prev/next-week buttons move `weekStart`, which silently
  // retargets the hours panel too — so it has to say which week it is showing,
  // or a future week's 0.0h everywhere reads as a broken fetch.
  const weekLabel = `${formatDayMonth(dates[0]!)} – ${formatDayMonth(dates[6]!)}`;

  const rotaCards: RotaCard[] = useMemo(() => {
    if (!activeEmployee) return [];
    const shifts = shiftsFor(mergedRoster, activeEmployee.id);
    return dates.map((date) => {
      const dayShifts = shifts.filter((s) => s.date === date);
      const leave = weekLeaves.find((l) => l.userId === activeEmployee.id && l.date === date);
      const leaveLabel = leave ? LEAVE_LABELS[leave.type] : undefined;
      if (dayShifts.length === 0) {
        return {
          id: `${activeEmployee.id}-${date}`,
          day: weekdayOf(date),
          date: formatDayMonth(date),
          venue: '',
          role: leaveLabel ?? 'Rest day',
          leaveLabel,
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
        venue: venueName ?? '',
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
        sectionAssignments: myAssignments
          .filter((a) => a.shiftDate === date)
          .map((a) => `${a.sectionLabel} (${a.period})`),
        leaveLabel,
      };
    });
  }, [mergedRoster, activeEmployee, dates, venueName, swapRequests, myAssignments, weekLeaves]);

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
  const [selfClockedIn, setSelfClockedIn] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  // A STAFF session can only ever clock ITSELF in/out server-side (see
  // attendance.ts's on-behalf-of rule) — but the "Viewing" dropdown
  // (`activeEmployee`) defaults to the roster's first employee, not to the
  // signed-in user, and exists for a different purpose (a manager checking a
  // colleague's Personal Rota). Tying the clock buttons to `activeEmployee`
  // for STAFF meant they silently clocked in whichever employee the dropdown
  // happened to default to, not the STAFF user themselves — a real bug this
  // decouples: the clock target for STAFF is always their own identity,
  // independent of whatever's selected in "Viewing"; MANAGER/OWNER keeps the
  // existing on-behalf-of capability against the Viewing selection.
  const isStaffSession = session?.user.systemRole === 'STAFF';
  const clockTargetId = isStaffSession ? session!.user.id : activeEmployee?.id;
  const clockTargetName = isStaffSession ? session!.user.fullName : activeEmployee?.name;

  const refreshHours = useCallback(() => {
    // This route is behind RequireSession, so locationId/session are
    // non-null in practice — guarded the same way as the other read-fetches
    // in this sweep (AppStateContext.tsx's refetchWeekShifts) purely for
    // TypeScript. weekly-hours became session-gated in the anonymous-read
    // sweep (2026-08-31 — see MEMORY.md).
    if (!locationId || !session) {
      setHourStaff([]);
      return;
    }
    fetchWeeklyHours(session.token, locationId, mergedRoster.weekStart)
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
        // `weekly-hours` returns every active user at the venue (queried by
        // locationId, not by roster/shift membership), so this resolves
        // correctly even for a STAFF session with no shift in the currently
        // -viewed week — unlike `mergedRoster.employees`, which wouldn't
        // contain them at all in that case.
        setSelfClockedIn(session ? (byId.get(session.user.id)?.clockedIn ?? false) : false);
      })
      .catch(() => setHourStaff([]));
  }, [mergedRoster.weekStart, mergedRoster.employees, config.compliance.maxWeeklyHours, activeEmployee, locationId, session]);

  useEffect(() => {
    refreshHours();
  }, [refreshHours]);

  const handleClockIn = () => {
    if (!clockTargetId) return;
    // Blocked outright while offline: a clock-in that actually lands minutes
    // or hours later than the real moment it happened is a real compliance/
    // payroll problem — no auto-retry, the button re-enables once back
    // online and the person clocks in again manually.
    if (!online) return;
    setClockError(null);
    clockIn(session!.token, clockTargetId)
      .then(() => refreshHours())
      .catch((err) => setClockError(err instanceof ApiError ? err.message : 'Could not clock in.'));
  };
  const handleClockOut = () => {
    if (!clockTargetId) return;
    if (!online) return;
    setClockError(null);
    clockOut(session!.token, clockTargetId)
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
          {isManager && mode === 'personal' && mergedRoster.employees.length > 0 && (
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

          {!initialScheduleLoading && mergedRoster.employees.length > 0 && !online && <StaleDataNotice />}

          <div key={mode} className="animate-rise">
            {initialScheduleLoading ? (
              mode === 'personal' ? (
                <PersonalRota shifts={[]} loading />
              ) : (
                <TeamMatrix venueName={venueName ?? ''} days={matrixDays} members={[]} matrix={[]} loading />
              )
            ) : mergedRoster.employees.length === 0 ? (
              <p className="panel p-5 text-sm text-muted-foreground">
                {!online && scheduleLoadFailed
                  ? "You're offline — nothing has loaded yet for this week."
                  : 'No staff parsed yet — upload a roster to see the personal and team views.'}
              </p>
            ) : mode === 'personal' ? (
              <PersonalRota shifts={rotaCards} coverCandidates={coverCandidates} onRequestCover={handleRequestCover} />
            ) : (
              <TeamMatrix venueName={venueName ?? ''} days={matrixDays} members={matrixMembers} matrix={matrixCells} />
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
            currentEmployeeName={clockTargetName}
            clockedIn={isStaffSession ? selfClockedIn : clockedIn}
            onClockIn={clockTargetId ? handleClockIn : undefined}
            onClockOut={clockTargetId ? handleClockOut : undefined}
            online={online}
          />
        </aside>
      </div>

      {isManager && (
        <div className="mt-5">
          <RotaBuilder />
        </div>
      )}

      <div className="mt-5">
        {isManager && <ShiftUpload onCommitted={handleCommitted} />}

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
