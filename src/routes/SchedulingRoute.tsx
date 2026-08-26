import { useMemo } from 'react';
import { useState } from 'react';
import { CalendarDays, LayoutGrid } from 'lucide-react';
import { periodOf, shiftsFor, totalHours, weekDates, weekdayOf } from '../engine/rosterView';
import { shiftHours } from '../engine/time';
import { nameKey } from '../engine/roleGrouping';
import { PersonalRota, type CoverCandidate, type RotaCard } from '../components/shiftsync/PersonalRota';
import { TeamMatrix, type MatrixCell, type MatrixMember } from '../components/shiftsync/TeamMatrix';
import { HourTracker } from '../components/shiftsync/HourTracker';
import ShiftUpload from '../components/ShiftUpload';
import { cn } from '../lib/utils';
import { useAppState } from '../state/AppStateContext';

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
  const {
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

  const [mode, setMode] = useState<Mode>('personal');
  const activeEmployee =
    mergedRoster.employees.find((e) => e.id === currentEmployeeId) ?? mergedRoster.employees[0];

  const dates = useMemo(() => weekDates(mergedRoster.weekStart), [mergedRoster.weekStart]);

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
      return {
        id: dayShifts[0].id,
        day: weekdayOf(date),
        date: formatDayMonth(date),
        venue: config.name,
        role: dayShifts[0].requiredRole ?? activeEmployee.role,
        start: dayShifts.map((s) => s.start).join(' / '),
        end: dayShifts.map((s) => s.end).join(' / '),
        hours: dayShifts.reduce((sum, s) => sum + shiftHours(s.start, s.end), 0),
        status: isPendingSwap ? 'swap-pending' : 'confirmed',
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

  const hourStaff = mergedRoster.employees.map((emp) => ({
    id: emp.id,
    name: emp.name,
    hours: totalHours(shiftsFor(mergedRoster, emp.id)),
    contract: config.compliance.maxWeeklyHours,
  }));

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
          <HourTracker staff={hourStaff} />
        </aside>
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
