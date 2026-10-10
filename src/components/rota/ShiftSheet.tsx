import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  LEAVE_LABELS,
  rangesEndNextDay,
  validateRanges,
  type IsoDate,
  type LeaveTypeCode,
  type TimeRange,
  type WeekDocDto,
  type WeekPatchOp,
  type WeekShiftDto,
} from '../../../shared/rotaWeek';
import { activeTypes, cellOf, fullDate, roleLine, shiftLabel, type WeekIndex } from '@/engine/rotaGrid';
import { openShiftOps, placeOps, roleForDepartment, tempId } from '@/engine/rotaPlans';
import { OfflineActionNotice } from '@/components/shiftsync/OfflineNotice';
import { Dialog, btn } from './Dialog';
import { tintSwatch } from './Dock';

/**
 * Shift detail (Design board B4): type picker, start/end, split toggle, a
 * staff-visible note (≤ 80), the person, its publish status, and Duplicate /
 * Make open / Delete. Opened from a chip, or from an empty cell to assign.
 * It only builds the ops; the builder sends them as one patch (and asks the
 * confirm sheet first when they land on a pending time-off request).
 */

export type ShiftSheetMode = { kind: 'edit'; shift: WeekShiftDto } | { kind: 'new'; date: IsoDate; userId: string | null };

export interface SheetSubmit {
  ops: WeekPatchOp[];
  label: string;
  /** The person-day the ops claim, for the pending-request check. */
  target: { date: IsoDate; userId: string | null } | null;
}

const NOTE_MAX = 80;
const field =
  'min-h-11 w-full min-w-0 rounded-xl border border-border-strong bg-background/60 px-3 text-sm tabular-nums text-foreground focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-ring';
const label = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

export function ShiftSheet(props: {
  week: WeekDocDto;
  idx: WeekIndex;
  mode: ShiftSheetMode;
  today: IsoDate;
  online: boolean;
  onSubmit: (s: SheetSubmit) => Promise<boolean>;
  onDelete: (shift: WeekShiftDto) => void;
  onClose: () => void;
}) {
  const { week, idx, mode, today, online, onSubmit, onDelete, onClose } = props;
  const types = useMemo(() => activeTypes(week.shiftTypes), [week.shiftTypes]);
  const shift = mode.kind === 'edit' ? mode.shift : null;
  const date = shift ? shift.date : mode.kind === 'new' ? mode.date : today;
  const startUser = shift ? shift.userId : mode.kind === 'new' ? mode.userId : null;
  const firstType = shift ? shift.shiftTypeId : (types[0]?.id ?? null);
  const initialRanges: TimeRange[] = shift ? shift.ranges : (types[0]?.ranges ?? [{ start: '09:00', end: '17:00' }]);

  const [typeId, setTypeId] = useState<string | null>(firstType);
  const [ranges, setRanges] = useState<TimeRange[]>(initialRanges.map((r) => ({ ...r })));
  const [note, setNote] = useState(shift?.note ?? '');
  const [userId, setUserId] = useState<string | null>(startUser);
  const [departmentId, setDepartmentId] = useState<string | null>(shift?.departmentId ?? week.departments[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = week.people.filter((p) => p.isActive || p.id === startUser);
  const person = userId ? week.people.find((p) => p.id === userId) : undefined;
  const cell = cellOf(idx, date, userId);
  const past = date < today;
  const split = ranges.length === 2;
  const valid = validateRanges(ranges);
  const nextDay = valid && rangesEndNextDay(ranges);
  const chosenType = types.find((t) => t.id === typeId);
  const matchesType = !!chosenType && chosenType.ranges.length === ranges.length && chosenType.ranges.every((r, i) => r.start === ranges[i]!.start && r.end === ranges[i]!.end);
  const otherShift = userId && userId !== startUser ? cellOf(idx, date, userId).shifts[0] : undefined;
  const lockedLeave = !!(userId && cell.leave?.fromRequest);

  const pickType = (id: string) => {
    const t = types.find((x) => x.id === id);
    setTypeId(id);
    if (t) setRanges(t.ranges.map((r) => ({ ...r })));
  };
  const setRange = (i: number, key: 'start' | 'end', value: string) => setRanges((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const toggleSplit = () => setRanges((rs) => (rs.length === 2 ? [{ start: rs[0]!.start, end: rs[1]!.end }] : [{ start: rs[0]!.start, end: '15:00' }, { start: '18:00', end: rs[0]!.end }]));

  const timing = (): { shiftTypeId?: string | null; ranges?: TimeRange[] } =>
    matchesType ? { shiftTypeId: typeId } : { shiftTypeId: chosenType ? chosenType.id : null, ranges: ranges.map((r) => ({ start: r.start, end: r.end })) };

  const submit = async (s: SheetSubmit) => {
    setError(null);
    setBusy(true);
    try {
      const ok = await onSubmit(s);
      if (ok) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that shift.');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!valid) return setError('Times must be one or two ranges; only the last may run past midnight, and they must not overlap.');
    if (note.trim().length > NOTE_MAX) return setError(`A note is at most ${NOTE_MAX} characters.`);
    const t = timing();
    const noteValue = note.trim() || null;
    const ops: WeekPatchOp[] = [];
    if (shift) {
      if (otherShift) ops.push({ op: 'delete', shiftId: otherShift.id });
      const target = userId ? cellOf(idx, date, userId) : null;
      if (target?.leave && userId !== shift.userId) ops.push({ op: 'clearLeave', userId: userId!, date });
      ops.push({
        op: 'update',
        shiftId: shift.id,
        ...(userId !== shift.userId ? { userId } : {}),
        ...(userId !== shift.userId && person?.roleId && person.roleId !== shift.roleId ? { roleId: person.roleId } : {}),
        ...(userId !== shift.userId && person?.departmentId ? { departmentId: person.departmentId } : {}),
        ...(userId === null && departmentId !== shift.departmentId ? { departmentId } : {}),
        ...t,
        note: noteValue,
      });
      return void submit({ ops, label: `Edited ${person?.fullName.split(' ')[0] ?? 'open shift'} · ${fullDate(date).split(' ').slice(0, 2).join(' ')}`, target: { date, userId } });
    }
    if (userId === null) {
      const roleId = roleForDepartment(week, departmentId);
      if (!roleId) return setError('Add a role to this venue first (People), so the open shift can be filed under it.');
      ops.push(...openShiftOps({ date, roleId, departmentId, content: { kind: 'custom', shiftTypeId: t.shiftTypeId ?? null, ranges, note: noteValue } }));
      return void submit({ ops, label: `Open shift added · ${fullDate(date).split(' ').slice(0, 2).join(' ')}`, target: null });
    }
    const r = placeOps(week, cell, { kind: 'custom', shiftTypeId: t.shiftTypeId ?? null, ranges, note: noteValue }, { today, allowPending: true });
    if (r.skip) return setError(r.skip === 'noRole' ? `${person?.fullName ?? 'This person'} has no role yet. Give them one in People first.` : 'That day cannot take a shift.');
    return void submit({ ops: r.ops, label: `Placed ${chosenType?.name ?? 'Custom'} · ${person?.fullName.split(' ')[0] ?? ''}`, target: { date, userId } });
  };

  const setStatus = (type: LeaveTypeCode | null) => {
    if (!userId) return;
    const r = placeOps(week, cell, type ? { kind: 'leave', type } : { kind: 'clear' }, { today });
    if (r.skip) return setError('Approved leave is locked. Decline the leave in Requests first.');
    void submit({ ops: r.ops, label: `${type ? LEAVE_LABELS[type] : 'Cleared'} · ${person?.fullName.split(' ')[0] ?? ''}`, target: null });
  };

  const duplicate = () => {
    if (!shift) return;
    const roleId = shift.roleId || roleForDepartment(week, shift.departmentId);
    if (!roleId) return setError('No role to file the copy under.');
    void submit({
      ops: [
        {
          op: 'create',
          tempId: tempId(),
          userId: null,
          date,
          roleId,
          departmentId: shift.departmentId,
          ...(shift.shiftTypeId ? { shiftTypeId: shift.shiftTypeId } : {}),
          ranges: shift.ranges,
          note: shift.note,
        },
      ],
      label: 'Duplicated as an open shift',
      target: null,
    });
  };

  const makeOpen = () => {
    if (!shift || shift.userId === null) return;
    void submit({ ops: [{ op: 'update', shiftId: shift.id, userId: null }], label: 'Made open', target: null });
  };

  const statusLine = shift
    ? shift.status === 'published'
      ? shift.editedSincePublish
        ? 'Published · changed since — told when you publish'
        : 'Published · no edits since'
      : week.publishedAt
        ? 'New since the last publish — told when you publish'
        : 'Draft · staff see nothing until you publish'
    : null;

  const writeDisabled = !online || past || busy || lockedLeave;
  const title = fullDate(date);

  return (
    <Dialog title={title} eyebrow={shift ? 'Shift' : userId ? 'Assign' : 'Open shift'} onClose={onClose} width="md" dismissable={!busy}>
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised p-3">
          <span aria-hidden="true" className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full border bg-surface text-xs font-bold', person ? 'border-border-strong' : 'border-dashed border-[var(--rota-ochre)] text-[var(--rota-ochre)]')}>
            {person?.initials ?? '+'}
          </span>
          <div className="min-w-0 flex-1">
            <label htmlFor="shift-person" className="sr-only">
              Person
            </label>
            <select id="shift-person" value={userId ?? ''} onChange={(e) => setUserId(e.target.value || null)} disabled={writeDisabled} className={cn(field, 'min-h-10 border-transparent bg-transparent px-0 text-[15px] font-semibold')}>
              <option value="">Open shift (unassigned)</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
            <p className="truncate text-xs text-muted-foreground">{person ? roleLine(person, week.departments) || 'No role yet' : 'Anyone can be dropped on it later'}</p>
          </div>
        </div>
        {otherShift && (
          <p className="text-xs text-warning">
            Replaces {person?.fullName.split(' ')[0]}’s {shiftLabel(otherShift, week.shiftTypes, week.clock)}.
          </p>
        )}
        {lockedLeave && <p className="text-xs text-warning">Approved leave that day. Decline the leave in Requests first.</p>}

        {userId === null && week.departments.length > 0 && (
          <div>
            <span className={label}>Department</span>
            <div role="radiogroup" aria-label="Department" className="flex flex-wrap gap-1.5">
              {week.departments.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="radio"
                  aria-checked={departmentId === d.id}
                  onClick={() => setDepartmentId(d.id)}
                  className={cn(btn.base, btn.sm, departmentId === d.id ? 'border-accent bg-accent/10 text-foreground' : btn.plain)}
                >
                  {d.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <span className={label}>Type</span>
          <div role="radiogroup" aria-label="Shift type" className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1.5">
            {types.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={typeId === t.id}
                onClick={() => pickType(t.id)}
                className={cn(
                  'flex min-h-11 items-center gap-2 rounded-xl border px-2.5 text-left text-[13px] font-semibold',
                  typeId === t.id ? 'border-accent bg-accent/10' : 'border-border-strong bg-surface-raised hover:bg-surface',
                )}
              >
                <span aria-hidden="true" className="h-4 w-2 shrink-0 rounded-[3px]" style={tintSwatch(t.tint)} />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <small className="shrink-0 font-medium tabular-nums text-muted-foreground">{t.ranges.map((r) => `${r.start.slice(0, 2)}–${r.end.slice(0, 2)}`).join(' · ')}</small>
              </button>
            ))}
            {!matchesType && <span className="flex min-h-11 items-center rounded-xl border border-dashed border-border-strong px-2.5 text-[13px] text-muted-foreground">Custom times</span>}
          </div>
        </div>

        <div className="space-y-2">
          {ranges.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2.5">
              <div>
                <label className={label} htmlFor={`start-${i}`}>
                  {split ? (i === 0 ? 'First part · starts' : 'Second part · starts') : 'Starts'}
                </label>
                <input id={`start-${i}`} type="time" value={r.start} onChange={(e) => setRange(i, 'start', e.target.value)} className={field} />
              </div>
              <div>
                <label className={label} htmlFor={`end-${i}`}>
                  Ends{i === ranges.length - 1 && nextDay ? <span className="normal-case tracking-normal text-accent"> · next day</span> : null}
                </label>
                <input id={`end-${i}`} type="time" value={r.end} onChange={(e) => setRange(i, 'end', e.target.value)} className={field} />
              </div>
            </div>
          ))}
          <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-3">
            <span className="flex flex-col">
              <span className="text-sm font-semibold">Split shift</span>
              <span className="text-xs text-muted-foreground">Two time ranges in one shift</span>
            </span>
            <input type="checkbox" role="switch" checked={split} onChange={toggleSplit} className="h-5 w-9 accent-[var(--accent)]" />
          </label>
        </div>

        <div>
          <label className={label} htmlFor="shift-note">
            Note · visible to {person ? person.fullName.split(' ')[0] : 'whoever takes it'}
          </label>
          <input id="shift-note" value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Brief at 15:45" className={field} />
          <p className="mt-1 text-end text-[11px] tabular-nums text-muted-foreground">
            {note.length}/{NOTE_MAX}
          </p>
        </div>

        {statusLine && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised p-3">
            <div>
              <p className="text-[13px] font-semibold">Status</p>
              <p className="text-xs text-muted-foreground">{statusLine}</p>
            </div>
            <span className={cn('rounded-full border px-2 py-px text-[10px] font-bold uppercase tracking-[0.06em]', shift?.status === 'published' ? 'border-success/55 text-success' : 'border-border-strong text-muted-foreground')}>
              {shift?.status === 'published' ? 'Published' : 'Draft'}
            </span>
          </div>
        )}

        {shift ? (
          <div className="grid grid-cols-3 gap-2">
            <button type="button" onClick={duplicate} disabled={writeDisabled} className={cn(btn.base, btn.plain, 'px-2')}>
              <Copy aria-hidden="true" className="h-4 w-4" /> Duplicate
            </button>
            <button type="button" onClick={makeOpen} disabled={writeDisabled || shift.userId === null} className={cn(btn.base, btn.plain, 'px-2')}>
              Make open
            </button>
            <button type="button" onClick={() => onDelete(shift)} disabled={writeDisabled} className={cn(btn.base, btn.danger, 'px-2')}>
              Delete
            </button>
          </div>
        ) : (
          userId && (
            <div>
              <span className={label}>Or mark the day</span>
              <div className="flex flex-wrap gap-1.5">
                {(['DAY_OFF', 'ANNUAL_LEAVE', 'SICK_LEAVE', 'HALF_DAY'] as LeaveTypeCode[]).map((t) => (
                  <button key={t} type="button" disabled={writeDisabled} onClick={() => setStatus(t)} className={cn(btn.base, btn.sm, btn.plain)}>
                    {LEAVE_LABELS[t]}
                  </button>
                ))}
                {cell.leave && (
                  <button type="button" disabled={writeDisabled} onClick={() => setStatus(null)} className={cn(btn.base, btn.sm, btn.ghost)}>
                    Clear {LEAVE_LABELS[cell.leave.type].toLowerCase()}
                  </button>
                )}
              </div>
            </div>
          )
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {past && <p className="text-xs text-muted-foreground">This day has passed; it can no longer be changed.</p>}
        <button type="button" onClick={save} disabled={writeDisabled || !valid} className={cn(btn.base, btn.gold, 'w-full')}>
          {busy ? 'Saving…' : shift ? 'Save changes' : 'Add shift'}
        </button>
        {shift && week.publishedAt && (
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            Saving on a published week marks this shift as changed; {person ? person.fullName.split(' ')[0] : 'whoever takes it'} is told when you publish.
          </p>
        )}
        {!online && <OfflineActionNotice />}
      </div>
    </Dialog>
  );
}
