import { ChevronRight } from 'lucide-react';
import { weekDays, type IsoDate, type WeekDocDto, type WeekPersonDto } from '../../../../shared/rotaWeek';
import { cn } from '../../../lib/utils';
import { ShiftChip, StatusChip } from '../chips';
import { dayOfMonth, longDate, personDay, roleLine, shortWeekday } from '../staff/weekModel';
import { describeDay } from './phoneModel';

/**
 * Phone Person view (Design board B3, "Phone-Person"): pick a person from the
 * avatar strip, see their seven days, tap a day to assign it in one tap.
 * Drag between days is not offered on the phone (long-press is reserved for
 * scrolling here); moving a shift is "tap the day, pick the type".
 */
export function PhonePersonView(props: {
  week: WeekDocDto;
  people: WeekPersonDto[];
  personId: string | null;
  today: IsoDate;
  onPickPerson: (id: string) => void;
  onDay: (userId: string, date: IsoDate) => void;
}) {
  const { week, people, personId, today, onPickPerson, onDay } = props;
  const person = people.find((p) => p.id === personId) ?? people[0] ?? null;
  const weekPublished = week.state === 'published' || week.publishedVersion !== null;
  if (!person) return <p className="py-6 text-sm text-muted-foreground">No one is on the team yet. Add people from the People tab.</p>;
  const days = weekDays(week.weekStart).map((date) => personDay(week, person.id, date));
  const shiftCount = days.reduce((n, d) => n + d.shifts.length, 0);

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="People" className="-mx-4 flex gap-2 overflow-x-auto px-4 py-1">
        {people.map((p) => {
          const on = p.id === person.id;
          return (
            <button
              key={p.id}
              type="button"
              aria-label={p.fullName}
              aria-pressed={on}
              onClick={() => onPickPerson(p.id)}
              className={cn(
                'inline-grid h-11 w-11 shrink-0 place-items-center rounded-full border bg-surface text-sm font-bold',
                on ? 'border-accent ring-2 ring-accent/35' : 'border-border-strong',
              )}
            >
              {p.initials}
            </button>
          );
        })}
      </div>

      <div className="flex min-w-0 flex-col">
        <span className="truncate text-lg font-semibold">{person.fullName}</span>
        <span className="truncate text-xs text-muted-foreground">
          {[roleLine(person, week.departments), `${shiftCount} ${shiftCount === 1 ? 'shift' : 'shifts'} this week`].filter(Boolean).join(' · ')}
        </span>
      </div>

      <div className="flex flex-col">
        {days.map((day) => {
          const s = day.shifts[0] ?? null;
          const isToday = day.date === today;
          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onDay(person.id, day.date)}
              aria-label={`${person.fullName}, ${longDate(day.date)}, ${describeDay(day, week.shiftTypes, week.clock)}${day.locked ? ', approved time off, locked' : ''}${day.pendingRequest ? ', time off requested' : ''}. Tap to change.`}
              className={cn(
                'grid min-h-[60px] w-full grid-cols-[64px_minmax(0,1fr)_24px] items-center gap-2.5 border-b border-border py-1.5 text-left',
                isToday && '-mx-4 w-[calc(100%+2rem)] bg-accent/6 px-4',
              )}
            >
              <span aria-hidden="true" className="flex flex-col leading-tight">
                <span className={cn('text-[11px] font-bold uppercase tracking-[0.08em]', isToday ? 'text-accent' : 'text-muted-foreground')}>{shortWeekday(day.date)}</span>
                <span className={cn('text-lg font-semibold tabular-nums', isToday && 'text-accent')}>{dayOfMonth(day.date)}</span>
              </span>
              <span aria-hidden="true" className="flex min-w-0 flex-col gap-0.5">
                {s ? (
                  <ShiftChip shift={s} types={week.shiftTypes} clock={week.clock} weekPublished={weekPublished} />
                ) : day.leave ? (
                  <StatusChip type={day.leave.type} locked={day.locked} requested={day.pendingRequest !== null && !day.locked} edited={weekPublished && day.leave.status === 'draft'} />
                ) : day.pendingRequest ? (
                  <StatusChip type="OFF_REQUESTED" />
                ) : (
                  <span className="flex min-h-11 items-center rounded-[10px] border border-dashed border-foreground/18 px-2.5 text-[13px] font-semibold text-muted-foreground">Tap to assign</span>
                )}
                {s && day.pendingRequest && (
                  <span className="text-[10px] font-bold uppercase tracking-[0.06em]" style={{ color: 'var(--rota-ochre)' }}>
                    Off requested · pending
                  </span>
                )}
              </span>
              <ChevronRight aria-hidden="true" className="h-5 w-5 text-muted-foreground/60" />
            </button>
          );
        })}
        <p className="mt-3.5 text-xs leading-relaxed text-muted-foreground">Tap a day to assign it in one tap.</p>
      </div>
    </div>
  );
}
