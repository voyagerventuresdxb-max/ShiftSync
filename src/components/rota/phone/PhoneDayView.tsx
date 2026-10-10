import { AlertTriangle } from 'lucide-react';
import { type IsoDate, type WeekDocDto, type WeekShiftDto } from '../../../../shared/rotaWeek';
import { ShiftChip, StatusChip, shiftAccessibleName } from '../chips';
import { longDate, personDay } from '../staff/weekModel';
import { dayGroups, describeDay } from './phoneModel';

/**
 * Phone Day view (Design board B3, "Phone-Day"): one day, people grouped by
 * department with their chip, open shifts under their department, and the
 * coverage line. Tapping a person opens the one-tap assign sheet; tapping an
 * existing shift chip opens the shift detail (B4).
 */
export function PhoneDayView(props: {
  week: WeekDocDto;
  date: IsoDate;
  onAssign: (userId: string, date: IsoDate) => void;
  onShift: (shift: WeekShiftDto) => void;
}) {
  const { week, date, onAssign, onShift } = props;
  const weekPublished = week.state === 'published' || week.publishedVersion !== null;
  const cov = week.coverage.find((c) => c.date === date);
  const deptName = (id: string) => week.departments.find((d) => d.id === id)?.name ?? 'Other';
  const short = cov?.uncovered.filter((u) => u.short > 0) ?? [];

  const sections = dayGroups(week, date);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span>
          <b className="text-foreground">{cov?.on ?? 0}</b> on · {cov?.off ?? 0} off{cov && cov.leave > 0 ? ` · ${cov.leave} on leave` : ''}
        </span>
        {short.length === 0 ? (
          <span className="inline-flex items-center gap-1.5 font-bold text-success">
            <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-success" />
            Covered
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-bold" style={{ color: 'var(--rota-ochre)' }}>
            <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
            {short.map((u) => `${deptName(u.departmentId)} needs ${u.short}`).join(' · ')}
          </span>
        )}
      </div>

      {sections.map(({ group: g, open: openShifts }) => {
        return (
          <section key={g.id} aria-label={`${g.name}, ${g.people.length} people`}>
            <h3 className="flex items-center gap-2 pb-1.5 pt-3.5 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
              <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full" style={{ background: `var(--rota-${g.tint})` }} />
              {g.name} · {g.people.length}
            </h3>
            {g.people.map((p) => {
              const day = personDay(week, p.id, date);
              const s = day.shifts[0] ?? null;
              const label = s
                ? `${shiftAccessibleName({ personName: p.fullName, date, shift: s, types: week.shiftTypes })}. Tap to edit.`
                : `${p.fullName}, ${longDate(date)}, ${describeDay(day, week.shiftTypes, week.clock)}${day.locked ? ', approved time off, locked' : ''}${day.pendingRequest ? ', time off requested' : ''}. Tap to assign.`;
              return (
                <div key={p.id} className="grid min-h-14 grid-cols-[minmax(0,1fr)_150px] items-center gap-2.5 border-b border-border py-1.5">
                  <button
                    type="button"
                    aria-label={`${p.fullName}, ${longDate(date)}: ${describeDay(day, week.shiftTypes, week.clock)}. Assign.`}
                    onClick={() => onAssign(p.id, date)}
                    className="grid min-h-11 min-w-0 grid-cols-[34px_minmax(0,1fr)] items-center gap-2.5 text-left"
                  >
                    <span aria-hidden="true" className="inline-grid h-[34px] w-[34px] place-items-center rounded-full border border-border-strong bg-surface text-xs font-bold">
                      {p.initials}
                    </span>
                    <span className="min-w-0 truncate text-[15px] font-semibold">{p.fullName}</span>
                  </button>
                  <button type="button" aria-label={label} onClick={() => (s ? onShift(s) : onAssign(p.id, date))} className="flex min-w-0 flex-col gap-0.5 text-left">
                    {s ? (
                      <ShiftChip shift={s} types={week.shiftTypes} clock={week.clock} weekPublished={weekPublished} />
                    ) : day.leave ? (
                      <StatusChip type={day.leave.type} locked={day.locked} requested={day.pendingRequest !== null && !day.locked} edited={weekPublished && day.leave.status === 'draft'} />
                    ) : day.pendingRequest ? (
                      <StatusChip type="OFF_REQUESTED" />
                    ) : (
                      <StatusChip type="DAY_OFF" />
                    )}
                    {s && day.pendingRequest && (
                      <span className="text-[10px] font-bold uppercase tracking-[0.06em]" style={{ color: 'var(--rota-ochre)' }}>
                        Off requested
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
            {openShifts.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-label={`${shiftAccessibleName({ personName: null, date, shift: s, types: week.shiftTypes })}. Tap to assign someone.`}
                onClick={() => onShift(s)}
                className="grid min-h-14 w-full grid-cols-[34px_minmax(0,1fr)_150px] items-center gap-2.5 border-b border-border py-1.5 text-left"
              >
                <span aria-hidden="true" className="inline-grid h-[34px] w-[34px] place-items-center rounded-full border border-dashed border-border-strong text-xs font-bold text-muted-foreground">
                  ?
                </span>
                <span className="min-w-0 truncate text-[15px] font-semibold text-muted-foreground">Open shift</span>
                <span aria-hidden="true" className="min-w-0">
                  <ShiftChip shift={s} types={week.shiftTypes} clock={week.clock} open />
                </span>
              </button>
            ))}
          </section>
        );
      })}
      {sections.length === 0 && <p className="py-6 text-sm text-muted-foreground">No one is on the team yet. Add people from the People tab.</p>}
    </div>
  );
}
