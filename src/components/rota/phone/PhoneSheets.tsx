import { useMemo, useState, type ReactNode } from 'react';
import { Clock, Plus, Trash2, UserPlus } from 'lucide-react';
import { formatRange, rangesEndNextDay, validateRanges, type TimeRange, type WeekDocDto, type WeekPersonDto, type WeekShiftDto } from '../../../../shared/rotaWeek';
import { cn } from '../../../lib/utils';
import { formatStamp, longDate, type PersonDay } from '../staff/weekModel';
import { describeDay, type CellAction } from './phoneModel';
import { BottomSheet, SheetHeader } from './BottomSheet';

const NOTE_MAX = 80;

function Avatar({ initials, size = 'md' }: { initials: string; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full border border-border-strong bg-surface font-bold',
        size === 'lg' ? 'h-11 w-11 text-[15px]' : 'h-10 w-10 text-[13px]',
      )}
    >
      {initials}
    </span>
  );
}

function Swatch({ tint, className }: { tint: string; className?: string }) {
  return <span aria-hidden="true" className={cn('shrink-0 rounded-[3px]', className)} style={{ background: `color-mix(in oklab, var(--rota-${tint}) 75%, transparent)` }} />;
}

// ---------------------------------------------------------------------------
// Assign sheet (B3 person view): one tap places a type or a status
// ---------------------------------------------------------------------------

export function AssignSheet(props: {
  week: WeekDocDto;
  person: WeekPersonDto;
  shortName: string;
  day: PersonDay;
  disabled: boolean;
  onPick: (action: CellAction) => void;
  onEditDetails: (() => void) | null;
  onClose: () => void;
}) {
  const { week, person, shortName, day, disabled, onPick, onEditDetails, onClose } = props;
  const types = week.shiftTypes.filter((t) => !t.archivedAt);
  const current = day.shifts[0] ?? null;
  const hasSomething = day.shifts.length > 0 || day.leave !== null;
  const statuses: { label: string; action: CellAction; on: boolean }[] = [
    { label: 'Day off', action: { kind: 'leave', type: 'DAY_OFF' }, on: day.shifts.length === 0 && day.leave?.type === 'DAY_OFF' },
    { label: 'Leave', action: { kind: 'leave', type: 'ANNUAL_LEAVE' }, on: day.shifts.length === 0 && day.leave?.type === 'ANNUAL_LEAVE' },
    { label: 'Sick', action: { kind: 'leave', type: 'SICK_LEAVE' }, on: day.shifts.length === 0 && day.leave?.type === 'SICK_LEAVE' },
  ];

  return (
    <BottomSheet label={`Assign ${person.fullName}, ${longDate(day.date)}`} onClose={onClose}>
      <SheetHeader eyebrow="Assign" title={`${shortName} · ${longDate(day.date)}`} sub={`Now: ${describeDay(day, week.shiftTypes, week.clock)}`} onClose={onClose} />
      {day.pendingRequest && (
        <p className="flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[13px]" style={{ color: 'var(--rota-ochre)', borderColor: 'color-mix(in oklab, var(--rota-ochre) 55%, transparent)' }}>
          <Clock aria-hidden="true" className="h-4 w-4 shrink-0" />
          {shortName} asked for this day off · pending
        </p>
      )}
      {types.length === 0 ? (
        <p className="text-sm text-muted-foreground">This venue has no shift types yet. Add them from the week view on a larger screen.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {types.map((t) => {
            const on = current?.shiftTypeId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => onPick({ kind: 'type', shiftTypeId: t.id })}
                className={cn(
                  'flex min-h-[52px] w-full items-center gap-2.5 rounded-xl border bg-surface px-3 text-left text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  on ? 'border-accent ring-2 ring-accent/35' : 'border-border-strong hover:border-accent/50',
                )}
              >
                <Swatch tint={t.tint} className="h-6 w-2.5" />
                <span className="min-w-0 truncate">{t.name}</span>
                <span className="ml-auto shrink-0 text-[13px] font-medium tabular-nums text-muted-foreground">
                  {t.ranges.map((r) => formatRange(r, week.clock)).join(' · ')}
                  {t.endsNextDay && <span className="rota-next-day ml-1">+1</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex gap-2">
        {statuses.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={disabled}
            aria-pressed={s.on}
            onClick={() => onPick(s.action)}
            className={cn(
              'min-h-11 flex-1 rounded-xl border bg-surface px-2 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              s.on ? 'border-accent text-foreground' : 'border-border-strong hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      {(onEditDetails || hasSomething) && (
        <div className="flex gap-2">
          {onEditDetails && (
            <button type="button" onClick={onEditDetails} className="min-h-11 flex-1 rounded-xl border border-border-strong px-3 text-sm font-semibold hover:border-accent/50">
              Edit details
            </button>
          )}
          {hasSomething && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick({ kind: 'erase' })}
              className="min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear day
            </button>
          )}
        </div>
      )}
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// Confirm sheet (A2 pattern): name, role, full date, times, big Confirm
// ---------------------------------------------------------------------------

export interface ConfirmContent {
  personName: string;
  initials: string;
  roleLine: string;
  /** "Thursday 8 October 2026" — never abbreviated. */
  dateLabel: string;
  /** "Mid · 11:00–20:00" */
  shiftLine: string;
  replaces: string | null;
  /** "Declines Person's time-off request" */
  consequence: string | null;
}

export function ConfirmSheet(props: { content: ConfirmContent; disabled: boolean; onConfirm: () => void; onEdit: (() => void) | null; onCancel: () => void }) {
  const { content, disabled, onConfirm, onEdit, onCancel } = props;
  return (
    <BottomSheet label="Confirm shift" onClose={onCancel} dismissible={false}>
      <span className="eyebrow text-accent">Confirm shift</span>
      <div className="flex items-center gap-3">
        <Avatar initials={content.initials} size="lg" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xl font-semibold">{content.personName}</span>
          {content.roleLine && <span className="truncate text-[13px] text-muted-foreground">{content.roleLine}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-0.5 rounded-2xl border border-border bg-background px-4 py-3.5">
        <span className="font-['Instrument_Serif',ui-serif,Georgia,serif] text-[26px] leading-tight">{content.dateLabel}</span>
        <span className="text-base tabular-nums">{content.shiftLine}</span>
        {content.replaces && <span className="text-[13px] text-muted-foreground">Replaces: {content.replaces}</span>}
        {content.consequence && (
          <span className="text-[13px]" style={{ color: 'var(--rota-ochre)' }}>
            {content.consequence}
          </span>
        )}
      </div>
      <button
        type="button"
        data-autofocus
        disabled={disabled}
        onClick={onConfirm}
        className="min-h-14 w-full rounded-2xl bg-accent px-4 text-base font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        Confirm
      </button>
      <div className="flex gap-2">
        {onEdit && (
          <button type="button" onClick={onEdit} className="min-h-11 flex-1 rounded-xl border border-border-strong px-3 text-sm font-semibold">
            Edit
          </button>
        )}
        <button type="button" onClick={onCancel} className="min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// Shift detail sheet (B4)
// ---------------------------------------------------------------------------

export interface ShiftEdit {
  userId: string | null;
  shiftTypeId: string | null;
  ranges: TimeRange[];
  note: string | null;
}

const sameRanges = (a: TimeRange[], b: TimeRange[]) => a.length === b.length && a.every((r, i) => r.start === b[i]!.start && r.end === b[i]!.end);

function TimeField(props: { id: string; label: ReactNode; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={props.id} className="text-xs font-semibold tracking-[0.04em] text-muted-foreground">
        {props.label}
      </label>
      <input
        id={props.id}
        type="time"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-[15px] tabular-nums text-foreground disabled:opacity-60"
      />
    </div>
  );
}

export function ShiftDetailSheet(props: {
  week: WeekDocDto;
  shift: WeekShiftDto;
  people: WeekPersonDto[];
  personRoleLine: string;
  disabled: boolean;
  onSave: (edit: ShiftEdit) => void;
  onDuplicate: () => void;
  onMakeOpen: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { week, shift, people, personRoleLine, disabled, onSave, onDuplicate, onMakeOpen, onDelete, onClose } = props;
  const types = week.shiftTypes.filter((t) => !t.archivedAt || t.id === shift.shiftTypeId);
  const [userId, setUserId] = useState<string | null>(shift.userId);
  const [typeId, setTypeId] = useState<string | null>(shift.shiftTypeId);
  const [ranges, setRanges] = useState<TimeRange[]>(shift.ranges.map((r) => ({ ...r })));
  const [note, setNote] = useState(shift.note ?? '');

  const person = people.find((p) => p.id === userId) ?? null;
  const valid = validateRanges(ranges);
  const nextDay = valid && rangesEndNextDay(ranges);
  const trimmedNote = note.trim();
  const changed =
    userId !== shift.userId || typeId !== shift.shiftTypeId || !sameRanges(ranges, shift.ranges) || (trimmedNote || null) !== (shift.note ?? null);
  const status = shift.status === 'draft' ? 'Draft' : shift.editedSincePublish ? 'Changed' : 'Published';
  const statusLine = useMemo(() => {
    if (shift.status === 'draft') return 'Not published yet';
    const when = week.publishedAt ? `Published ${formatStamp(week.publishedAt, week.timezone)}` : 'Published';
    return shift.editedSincePublish ? `${when} · changed since` : `${when} · no edits since`;
  }, [shift.status, shift.editedSincePublish, week.publishedAt, week.timezone]);

  const pickType = (id: string | null) => {
    setTypeId(id);
    const t = week.shiftTypes.find((x) => x.id === id);
    if (t && t.ranges.length > 0) setRanges(t.ranges.map((r) => ({ ...r })));
  };
  const setRange = (i: number, key: 'start' | 'end', v: string) => setRanges((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const toggleSplit = () =>
    setRanges((rs) => (rs.length > 1 ? [rs[0]!] : [rs[0]!, { start: rs[0]!.end < '18:00' ? '18:00' : rs[0]!.end, end: '23:00' }]));
  const firstName = person?.fullName.split(/\s+/)[0] ?? 'they';

  return (
    <BottomSheet label={`Shift: ${person?.fullName ?? 'Open shift'}, ${longDate(shift.date)}`} onClose={onClose} className="max-h-[92dvh]">
      <SheetHeader eyebrow="Shift" title={longDate(shift.date, true)} display onClose={onClose} />

      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2">
        {person ? <Avatar initials={person.initials} /> : <span aria-hidden="true" className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-full border border-dashed border-border-strong text-muted-foreground">?</span>}
        <div className="flex min-w-0 flex-1 flex-col">
          <label htmlFor="shift-person" className="sr-only">
            Person
          </label>
          <select
            id="shift-person"
            value={userId ?? ''}
            disabled={disabled}
            onChange={(e) => setUserId(e.target.value || null)}
            className="min-h-11 w-full truncate rounded-lg border border-transparent bg-transparent text-[15px] font-semibold text-foreground hover:border-border-strong"
          >
            <option value="">Open shift (nobody yet)</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
          {userId === shift.userId && personRoleLine && <span className="truncate text-xs text-muted-foreground">{personRoleLine}</span>}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold tracking-[0.04em] text-muted-foreground">Type</span>
        <div role="radiogroup" aria-label="Shift type" className="grid grid-cols-4 gap-1.5">
          {types.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={typeId === t.id}
              disabled={disabled}
              onClick={() => pickType(t.id)}
              className={cn(
                'flex min-h-[52px] min-w-0 flex-col items-center justify-center gap-1 rounded-xl border bg-surface px-1 text-xs font-semibold',
                typeId === t.id ? 'border-accent bg-accent/12 ring-2 ring-accent/35' : 'border-border-strong',
              )}
            >
              <Swatch tint={t.tint} className="h-1.5 w-5 rounded-full" />
              <span className="max-w-full truncate">{t.name}</span>
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={typeId === null}
            disabled={disabled}
            onClick={() => pickType(null)}
            className={cn(
              'flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl border bg-surface px-1 text-xs font-semibold',
              typeId === null ? 'border-accent bg-accent/12 ring-2 ring-accent/35' : 'border-border-strong',
            )}
          >
            <span aria-hidden="true" className="h-1.5 w-5 rounded-full border border-dashed border-border-strong" />
            Custom
          </button>
        </div>
      </div>

      {ranges.map((r, i) => (
        <div key={i} className="grid grid-cols-2 gap-2.5">
          <TimeField id={`start-${i}`} label={ranges.length > 1 ? `Part ${i + 1} starts` : 'Starts'} value={r.start} disabled={disabled} onChange={(v) => setRange(i, 'start', v)} />
          <TimeField
            id={`end-${i}`}
            label={
              <>
                {ranges.length > 1 ? `Part ${i + 1} ends` : 'Ends'}
                {i === ranges.length - 1 && nextDay && <span className="text-accent"> · next day</span>}
              </>
            }
            value={r.end}
            disabled={disabled}
            onChange={(v) => setRange(i, 'end', v)}
          />
        </div>
      ))}
      <label className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3">
        <span className="text-sm font-semibold">Split shift</span>
        <input type="checkbox" role="switch" checked={ranges.length > 1} disabled={disabled} onChange={toggleSplit} className="h-5 w-5 accent-[var(--accent)]" />
      </label>
      {!valid && (
        <p className="text-xs text-destructive" role="alert">
          Check the times: each part needs a start and an end, only the last part may run past midnight, and the two parts may not overlap.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="shift-note" className="flex justify-between text-xs font-semibold tracking-[0.04em] text-muted-foreground">
          <span>Note · visible to {firstName}</span>
          <span className="tabular-nums">
            {note.length}/{NOTE_MAX}
          </span>
        </label>
        <input
          id="shift-note"
          value={note}
          maxLength={NOTE_MAX}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
          className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-[15px] text-foreground disabled:opacity-60"
        />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold">Status</span>
          <span className="text-xs text-muted-foreground">{statusLine}</span>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em]',
            status === 'Published' ? 'border-success/55 text-success' : 'border-accent/60 text-accent',
          )}
        >
          {status}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button type="button" disabled={disabled} onClick={onDuplicate} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border-strong bg-surface px-2 text-[13px] font-semibold disabled:opacity-50">
          <Plus aria-hidden="true" className="h-4 w-4" />
          Duplicate
        </button>
        <button
          type="button"
          disabled={disabled || shift.userId === null}
          onClick={onMakeOpen}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border-strong bg-surface px-2 text-[13px] font-semibold disabled:opacity-50"
        >
          <UserPlus aria-hidden="true" className="h-4 w-4" />
          Make open
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onDelete}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-destructive/55 px-2 text-[13px] font-semibold text-destructive disabled:opacity-50"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
          Delete
        </button>
      </div>

      <button
        type="button"
        disabled={disabled || !changed || !valid}
        onClick={() => onSave({ userId, shiftTypeId: typeId, ranges, note: trimmedNote || null })}
        className="min-h-[52px] w-full rounded-xl bg-accent px-4 text-[15px] font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        Save changes
      </button>
      {week.state === 'published' && (
        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          Saving on a published week marks this shift as changed; {person ? firstName : 'the person'} is told when you publish.
        </p>
      )}
    </BottomSheet>
  );
}
