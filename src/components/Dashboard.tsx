import { useMemo, useState } from 'react';
import { CalendarDays, LayoutGrid } from 'lucide-react';
import type { Roster, SwapRequest, VenueConfig } from '../engine/types';
import { periodOf, shiftsFor, totalHours, weekDates, weekdayOf } from '../engine/rosterView';
import { shiftHours } from '../engine/time';
import { PersonalRota, type CoverCandidate, type RotaCard } from './shiftsync/PersonalRota';
import { TeamMatrix, type MatrixCell, type MatrixMember } from './shiftsync/TeamMatrix';
import { HourTracker } from './shiftsync/HourTracker';
import { ApprovalsPanel, type ApprovalRequestView } from './shiftsync/ApprovalsPanel';
import { SafetyValve } from './shiftsync/SafetyValve';
import { PredictiveBanner } from './shiftsync/PredictiveBanner';
import { cn } from '../lib/utils';

type Mode = 'personal' | 'matrix';

interface DashboardProps {
  roster: Roster;
  config: VenueConfig;
  swapRequests: SwapRequest[];
  onRequestCover: (shiftId: string, coveringEmployeeId: string) => void;
  onDecideRequest: (requestId: string, decision: 'approved' | 'denied') => void;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

function formatDayMonth(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function Dashboard({
  roster,
  config,
  swapRequests,
  onRequestCover,
  onDecideRequest,
}: DashboardProps) {
  const [mode, setMode] = useState<Mode>('personal');
  const [employeeId, setEmployeeId] = useState<string | undefined>(roster.employees[0]?.id);

  const activeEmployee =
    roster.employees.find((e) => e.id === employeeId) ?? roster.employees[0];

  const dates = useMemo(() => weekDates(roster.weekStart), [roster.weekStart]);

  const rotaCards: RotaCard[] = useMemo(() => {
    if (!activeEmployee) return [];
    const shifts = shiftsFor(roster, activeEmployee.id);
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
      return {
        id: dayShifts[0].id,
        day: weekdayOf(date),
        date: formatDayMonth(date),
        venue: config.name,
        role: dayShifts[0].requiredRole ?? activeEmployee.role,
        start: dayShifts.map((s) => s.start).join(' / '),
        end: dayShifts.map((s) => s.end).join(' / '),
        hours: dayShifts.reduce((sum, s) => sum + shiftHours(s.start, s.end), 0),
        status: 'confirmed',
      };
    });
  }, [roster, activeEmployee, dates, config.name]);

  const coverCandidates: CoverCandidate[] = activeEmployee
    ? roster.employees
        .filter((e) => e.id !== activeEmployee.id)
        .map((e) => ({ id: e.id, name: e.name }))
    : [];

  const matrixDays = dates.map((d) => `${weekdayOf(d)} ${Number(d.slice(8, 10))}`);

  const matrixMembers: MatrixMember[] = roster.employees.map((e) => ({
    id: e.id,
    name: e.name,
    role: e.role,
    initials: initialsOf(e.name),
  }));

  const matrixCells: MatrixCell[][] = roster.employees.map((emp) => {
    const shifts = shiftsFor(roster, emp.id);
    return dates.map((date): MatrixCell => {
      const dayShifts = shifts.filter((s) => s.date === date);
      if (dayShifts.length === 0) return { code: 'OFF', kind: 'off' };
      if (dayShifts.length > 1) {
        const roles = [...new Set(dayShifts.map((s) => s.requiredRole).filter(Boolean))];
        return { code: 'D', kind: 'double', requiredRole: roles.join(' + ') || undefined };
      }
      const period = periodOf(dayShifts[0]);
      const isAm = period ? period === 'AM' : Number(dayShifts[0].start.split(':')[0]) < 12;
      return {
        code: isAm ? 'AM' : 'PM',
        kind: isAm ? 'am' : 'pm',
        requiredRole: dayShifts[0].requiredRole,
      };
    });
  });

  const hourStaff = roster.employees.map((emp) => ({
    id: emp.id,
    name: emp.name,
    hours: totalHours(shiftsFor(roster, emp.id)),
    contract: config.compliance.maxWeeklyHours,
  }));

  const employeeName = (id: string) => roster.employees.find((e) => e.id === id)?.name ?? 'Unknown';

  const approvalRequests: ApprovalRequestView[] = swapRequests
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const shift = roster.shifts.find((s) => s.id === r.shiftId);
      const shiftLabel = shift
        ? `${weekdayOf(shift.date)} ${formatDayMonth(shift.date)} · ${shift.start}–${shift.end}`
        : 'Shift no longer in roster';
      return {
        id: r.id,
        status: r.status,
        requesterName: employeeName(r.requestedBy),
        coveringName: employeeName(r.coveringEmployeeId),
        shiftLabel,
        requestedAt: r.createdAt,
      };
    });

  return (
    <section className="dashboard my-8">
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
              mode === t.id
                ? 'bg-accent text-accent-foreground shadow-lux'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-5">
        <PredictiveBanner />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {mode === 'personal' && roster.employees.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">Viewing</span>
              <select
                value={activeEmployee?.id}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground"
              >
                {roster.employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div key={mode} className="animate-rise">
            {roster.employees.length === 0 ? (
              <p className="panel p-5 text-sm text-muted-foreground">
                No staff parsed yet — paste or upload a roster to see the personal and team views.
              </p>
            ) : mode === 'personal' ? (
              <PersonalRota
                shifts={rotaCards}
                coverCandidates={coverCandidates}
                onRequestCover={onRequestCover}
              />
            ) : (
              <TeamMatrix
                venueName={config.name}
                days={matrixDays}
                members={matrixMembers}
                matrix={matrixCells}
              />
            )}
          </div>

          <ApprovalsPanel
            requests={approvalRequests}
            onApprove={(id) => onDecideRequest(id, 'approved')}
            onDeny={(id) => onDecideRequest(id, 'denied')}
          />
        </div>

        <aside className="min-w-0 space-y-5">
          <HourTracker staff={hourStaff} />
          <SafetyValve />
        </aside>
      </div>
    </section>
  );
}
