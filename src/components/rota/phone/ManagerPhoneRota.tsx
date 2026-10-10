import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, WifiOff } from 'lucide-react';
import { LEAVE_LABELS, addDays, weekDays, type IsoDate, type TimeRange, type WeekDocDto, type WeekPatchOp, type WeekPatchResult, type WeekShiftDto } from '../../../../shared/rotaWeek';
import { useWeekDoc } from '../../../state/useWeekDoc';
import { useIdentity } from '../../../state/IdentityContext';
import { useConnectivity } from '../../../state/ConnectivityContext';
import { offlineLabel } from '../../../lib/offlineCache';
import { cn } from '../../../lib/utils';
import { displayNames, groupPeople, longDate, personDay, roleLine, venueNow, weekRangeLabel, type PersonDay } from '../staff/weekModel';
import {
  PAINT_BATCH_MS,
  actionLabel,
  batchOps,
  brushesOf,
  needsConfirm,
  opsForAction,
  pushUndo,
  queuePaint,
  replacesLine,
  restoreOps,
  shiftLine,
  snapshotOf,
  weekStrip,
  type CellAction,
  type CellSnapshot,
  type PendingPaint,
  type UndoEntry,
} from './phoneModel';
import { AssignSheet, ConfirmSheet, ShiftDetailSheet, type ConfirmContent, type ShiftEdit } from './PhoneSheets';
import { PhoneDayView } from './PhoneDayView';
import { PhonePersonView } from './PhonePersonView';
import { PhonePaintView } from './PhonePaintView';
import { Toast, type ToastState } from './Toast';

/**
 * Manager phone mode for the rota (Design boards B3/B4, Spec §1 "390"):
 * Day, Person and Paint views over the same week document the grid edits.
 * Mounted by the Scheduling tab for managers below 768 px.
 */
export interface ManagerPhoneRotaProps {
  locationId: string;
  weekStart: string;
  onWeekChange: (weekStart: string) => void;
}

type View = 'day' | 'person' | 'paint';

type Sheet =
  | { kind: 'assign'; userId: string; date: IsoDate }
  | { kind: 'detail'; shiftId: string }
  | { kind: 'confirm'; content: ConfirmContent; proceed: () => void; edit: (() => void) | null }
  | null;

type RunResult = 'ok' | 'pending_request' | 'failed';

interface RunInput {
  ops: WeekPatchOp[];
  /** Toast text on success, e.g. "Thu 8 → Mid (was Day off)". */
  label: string;
  /** Person-days touched, as they were (for undo). */
  cells: CellSnapshot[];
  /** Open shifts touched, as they were (for undo). */
  openShifts?: WeekShiftDto[];
  override?: boolean;
  /** Paint stroke id: entries of one stroke merge into one undo step. */
  stroke?: string | null;
  /** No toast on success (paint shows its own bar). */
  quiet?: boolean;
  /** Not recorded for undo (an undo itself). */
  noUndo?: boolean;
}

const TOAST_MS = 6000;
const OFFLINE_WRITE = 'You are offline. Changes to the rota are paused until you are back.';

let strokeSeq = 0;
const newStroke = () => `stroke-${++strokeSeq}`;
let undoSeq = 0;

const sameRanges = (a: TimeRange[], b: TimeRange[]) => a.length === b.length && a.every((r, i) => r.start === b[i]!.start && r.end === b[i]!.end);

export function ManagerPhoneRota(props: ManagerPhoneRotaProps) {
  const { locationId, weekStart, onWeekChange } = props;
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const { week, loading, error, offlineSince, patch, refetch, acceptServerWeek } = useWeekDoc({
    locationId,
    weekStart,
    sessionToken: session?.token ?? null,
    offlineUserId: session?.user.id ?? null,
  });

  // The latest rendered week, read by queued writes when they actually run.
  const weekRef = useRef(week);
  weekRef.current = week;

  const today = venueNow(week?.timezone ?? 'UTC').date;
  const days = useMemo(() => weekDays(weekStart), [weekStart]);

  const [view, setView] = useState<View>('day');
  const [dayIndex, setDayIndex] = useState(() => Math.max(0, weekDays(weekStart).indexOf(venueNow('UTC').date)));
  const date = days[Math.min(6, Math.max(0, dayIndex))]!;
  const [personId, setPersonId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const undoRef = useRef(undoStack);
  undoRef.current = undoStack;

  const people = useMemo(() => (week ? groupPeople(week).flatMap((g) => g.people) : []), [week]);
  const names = useMemo(() => displayNames(people), [people]);
  const shortName = useCallback((id: string | null) => (id ? (names.get(id) ?? people.find((p) => p.id === id)?.fullName ?? 'Someone') : 'Open shift'), [names, people]);

  // A new week: undo history is per week (Spec §2), and the paint stroke starts over.
  useEffect(() => {
    setUndoStack([]);
    setSheet(null);
  }, [weekStart]);

  // ---- toasts ---------------------------------------------------------------
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((message: string, tone: ToastState['tone'] = 'info', undo = false) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message, tone, undo });
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => {
    const timer = toastTimer;
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  // ---- serialised writes ------------------------------------------------------
  // Every write waits for the one before it and for its result to render, so
  // each patch presents the version the previous one produced (no self-inflicted
  // version conflicts from quick taps).
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback((job: () => Promise<unknown>) => {
    const next = chain.current.then(job);
    chain.current = next.catch(() => undefined);
    return next;
  }, []);
  const waiters = useRef<{ version: number; resolve: () => void }[]>([]);
  useEffect(() => {
    const v = week?.version ?? -1;
    waiters.current = waiters.current.filter((w) => {
      if (v >= w.version) {
        w.resolve();
        return false;
      }
      return true;
    });
  }, [week]);
  const waitForVersion = useCallback(
    (version: number) =>
      new Promise<void>((resolve) => {
        if ((weekRef.current?.version ?? -1) >= version) return resolve();
        waiters.current.push({ version, resolve });
        // Never hang the queue: after a moment the next write simply tries (and at worst gets a conflict).
        window.setTimeout(resolve, 1500);
      }),
    [],
  );

  const runPatch = useCallback(
    async (input: RunInput): Promise<RunResult> => {
      if (input.ops.length === 0) return 'ok';
      let result: WeekPatchResult;
      try {
        result = await patch({ ops: input.ops, ...(input.override ? { overridePendingRequests: true } : {}) });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not save that change.', 'error');
        return 'failed';
      }
      if (result.result === 'ok') {
        const created = result.results.filter((r) => input.ops[r.op]?.op === 'create' && r.shiftId).map((r) => r.shiftId!);
        const declined = result.declinedRequestIds.length > 0;
        if (!input.noUndo) {
          setUndoStack((s) =>
            pushUndo(s, {
              id: ++undoSeq,
              label: input.label,
              cells: input.cells,
              openShifts: input.openShifts ?? [],
              created,
              declinedRequest: declined,
              stroke: input.stroke ?? null,
              at: Date.now(),
            }),
          );
        }
        if (!input.quiet) showToast(declined ? `${input.label} · request declined` : input.label, 'info', !input.noUndo);
        await waitForVersion(result.version);
        return 'ok';
      }
      if (result.result === 'version_conflict') {
        // Another device saved first: show their week (nothing of ours was applied) and say so.
        acceptServerWeek();
        showToast('Someone else just changed this week. You are now seeing their latest version — try that again.', 'error');
        await waitForVersion(result.currentVersion);
        return 'failed';
      }
      if (result.refusal === 'pending_request' && !input.override) return 'pending_request';
      showToast(result.message, 'error');
      return 'failed';
    },
    [patch, showToast, waitForVersion, acceptServerWeek],
  );

  // ---- person-day actions (Day and Person views) ---------------------------
  // Plain functions, rebuilt each render. Anything that runs later (a queued
  // write, a confirm sheet's Confirm) goes through `latest` so it always uses
  // this render's versions, never a stale closure.
  const blockedMessage = (day: PersonDay) =>
    `${shortName(day.userId)} is on approved ${day.leave ? LEAVE_LABELS[day.leave.type].toLowerCase() : 'time off'} that day. Reverse the time-off approval from Requests first.`;

  const guard = (d: IsoDate): boolean => {
    if (!online) {
      showToast(OFFLINE_WRITE, 'error');
      return false;
    }
    if (d < today) {
      showToast('That day has already passed.', 'error');
      return false;
    }
    return true;
  };

  /** "Person · Thu 8 → Mid (was Day off)" */
  const changeLabel = (day: PersonDay, action: CellAction) => {
    const w = weekRef.current;
    if (!w) return 'Saved';
    const first = day.shifts[0];
    const was = first ? (w.shiftTypes.find((t) => t.id === first.shiftTypeId)?.name ?? 'Custom') : day.leave ? LEAVE_LABELS[day.leave.type] : 'Day off';
    const now = actionLabel(action, w.shiftTypes);
    const wd = new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '');
    return `${shortName(day.userId)} · ${wd} → ${now}${was !== now ? ` (was ${was})` : ''}`;
  };

  /** Apply one action to one person-day; a refusal for a pending request comes back through the confirm sheet. */
  const applyAction = (userId: string, d: IsoDate, action: CellAction, opts: { override?: boolean; stroke?: string | null } = {}) =>
    enqueue(async () => {
      const w = weekRef.current;
      if (!w) return;
      const day = personDay(w, userId, d);
      if (day.locked) {
        showToast(blockedMessage(day), 'error');
        return;
      }
      const r = await runPatch({ ops: opsForAction(day, action), label: changeLabel(day, action), cells: [snapshotOf(day)], override: opts.override, stroke: opts.stroke });
      if (r === 'pending_request') latest.current.openConfirmFor(userId, d, action, opts.stroke ?? null);
    });

  const confirmContent = (userId: string, d: IsoDate, typeName: string, ranges: WeekShiftDto['ranges'], day: PersonDay | null): ConfirmContent | null => {
    const w = weekRef.current;
    const p = w?.people.find((x) => x.id === userId);
    if (!w || !p) return null;
    return {
      personName: p.fullName,
      initials: p.initials,
      roleLine: roleLine(p, w.departments),
      dateLabel: longDate(d, true),
      shiftLine: shiftLine(typeName, ranges, w.clock),
      replaces: day ? replacesLine(day, w) : null,
      consequence: `Declines ${p.fullName.split(/\s+/)[0]}’s time-off request`,
    };
  };

  const openConfirmFor = (userId: string, d: IsoDate, action: CellAction, stroke: string | null) => {
    const w = weekRef.current;
    if (!w || action.kind !== 'type') return;
    const t = w.shiftTypes.find((x) => x.id === action.shiftTypeId);
    const content = confirmContent(userId, d, t?.name ?? 'Shift', t?.ranges ?? [], personDay(w, userId, d));
    if (!content) return;
    setSheet({
      kind: 'confirm',
      content,
      proceed: () => {
        setSheet(null);
        void latest.current.applyAction(userId, d, action, { override: true, stroke });
      },
      edit: stroke ? null : () => setSheet({ kind: 'assign', userId, date: d }),
    });
  };

  const openAssign = (userId: string, d: IsoDate) => {
    const w = weekRef.current;
    if (!w) return;
    const day = personDay(w, userId, d);
    if (day.locked) {
      showToast(blockedMessage(day), 'error');
      return;
    }
    if (d < today) {
      showToast('That day has already passed.', 'error');
      return;
    }
    setSheet({ kind: 'assign', userId, date: d });
  };

  const pickInSheet = (userId: string, d: IsoDate, action: CellAction) => {
    const w = weekRef.current;
    if (!w || !guard(d)) return;
    const day = personDay(w, userId, d);
    if (needsConfirm(day, action)) {
      openConfirmFor(userId, d, action, null);
      return;
    }
    setSheet(null);
    void applyAction(userId, d, action);
  };

  // ---- shift detail (B4) ------------------------------------------------------
  const cellsAround = (w: WeekDocDto, shift: WeekShiftDto, edit?: ShiftEdit): { cells: CellSnapshot[]; openShifts: WeekShiftDto[] } => {
    const cells: CellSnapshot[] = [];
    const openShifts: WeekShiftDto[] = [];
    if (shift.userId) cells.push(snapshotOf(personDay(w, shift.userId, shift.date)));
    else openShifts.push(shift);
    if (edit?.userId && edit.userId !== shift.userId) cells.push(snapshotOf(personDay(w, edit.userId, shift.date)));
    return { cells, openShifts };
  };

  const saveDetail = (shift: WeekShiftDto, edit: ShiftEdit, override = false) => {
    if (!guard(shift.date)) return;
    setSheet(null);
    void enqueue(async () => {
      const w = weekRef.current;
      if (!w) return;
      const typeChanged = edit.shiftTypeId !== shift.shiftTypeId;
      // Times go only when they change: re-sending them would re-validate the shift's (maybe archived) type.
      const timesChanged = typeChanged || !sameRanges(edit.ranges, shift.ranges);
      const op: WeekPatchOp = {
        op: 'update',
        shiftId: shift.id,
        ...(edit.userId !== shift.userId ? { userId: edit.userId } : {}),
        ...(typeChanged ? { shiftTypeId: edit.shiftTypeId } : {}),
        ...(timesChanged ? { ranges: edit.ranges } : {}),
        ...((edit.note ?? null) !== (shift.note ?? null) ? { note: edit.note } : {}),
      };
      const target = edit.userId ? personDay(w, edit.userId, shift.date) : null;
      if (target && edit.userId !== shift.userId && target.locked) {
        showToast(blockedMessage(target), 'error');
        return;
      }
      const r = await runPatch({ ops: [op], label: `${shortName(edit.userId)} · ${longDate(shift.date)} saved`, ...cellsAround(w, shift, edit), override });
      if (r === 'pending_request' && edit.userId) {
        const typeName = w.shiftTypes.find((t) => t.id === edit.shiftTypeId)?.name ?? 'Custom';
        const content = confirmContent(edit.userId, shift.date, typeName, edit.ranges, target);
        if (content) {
          setSheet({
            kind: 'confirm',
            content,
            proceed: () => latest.current.saveDetail(shift, edit, true),
            edit: () => setSheet({ kind: 'detail', shiftId: shift.id }),
          });
        }
      }
    });
  };

  const detailAction = (shift: WeekShiftDto, kind: 'duplicate' | 'open' | 'delete') => {
    if (!guard(shift.date)) return;
    setSheet(null);
    void enqueue(async () => {
      const w = weekRef.current;
      if (!w) return;
      const typeName = w.shiftTypes.find((t) => t.id === shift.shiftTypeId)?.name ?? 'Custom';
      if (kind === 'duplicate') {
        await runPatch({
          ops: [{ op: 'create', userId: null, roleId: shift.roleId, departmentId: shift.departmentId, date: shift.date, ...(shift.shiftTypeId ? { shiftTypeId: shift.shiftTypeId } : {}), ranges: shift.ranges, note: shift.note }],
          label: `${typeName} duplicated as an open shift`,
          cells: [],
        });
      } else if (kind === 'open') {
        await runPatch({ ops: [{ op: 'update', shiftId: shift.id, userId: null }], label: `${shortName(shift.userId)}’s ${typeName} is now an open shift`, ...cellsAround(w, shift) });
      } else {
        await runPatch({ ops: [{ op: 'delete', shiftId: shift.id }], label: `${typeName} on ${longDate(shift.date)} deleted`, ...cellsAround(w, shift) });
      }
    });
  };

  // ---- paint (B3) -----------------------------------------------------------
  // Batching rule: taps land on screen at once and are collected; 600 ms after
  // the last tap the batch goes to the server as ONE patch (one version bump,
  // one transaction — a refusal rolls the whole batch back and says why).
  // Batches are serialised with every other write. One paint session is one
  // undo step until Done or a 2 s pause (Spec §2).
  const [brush, setBrush] = useState<CellAction | null>(null);
  const [overlay, setOverlay] = useState<Map<string, CellAction>>(() => new Map());
  const [lastKey, setLastKey] = useState<string | null>(null);
  const pendingRef = useRef<PendingPaint[]>([]);
  const paintTimer = useRef<number | null>(null);
  const strokeRef = useRef(newStroke());
  const activeBrush: CellAction | null = brush ?? (week ? (brushesOf(week)[0]?.action ?? null) : null);

  const dropFromOverlay = (batch: PendingPaint[]) =>
    setOverlay((m) => {
      const next = new Map(m);
      for (const p of batch) if (next.get(`${p.userId}|${p.date}`) === p.action) next.delete(`${p.userId}|${p.date}`);
      return next;
    });

  const flushPaint = () => {
    if (paintTimer.current) window.clearTimeout(paintTimer.current);
    paintTimer.current = null;
    const batch = pendingRef.current;
    if (batch.length === 0) return;
    pendingRef.current = [];
    const stroke = strokeRef.current;
    void enqueue(async () => {
      const w = weekRef.current;
      if (w) {
        const { ops, cells } = batchOps(batch, (u, d) => personDay(w, u, d));
        const label = batch.length === 1 ? changeLabel(personDay(w, batch[0]!.userId, batch[0]!.date), batch[0]!.action) : `Painted ${batch.length} days`;
        const r = await runPatch({ ops, cells, label, stroke, quiet: true });
        if (r === 'pending_request') showToast('One of those days has a pending time-off request. Tap it again to confirm.', 'error');
      }
      dropFromOverlay(batch);
    });
  };

  const cancelPaint = () => {
    if (paintTimer.current) window.clearTimeout(paintTimer.current);
    paintTimer.current = null;
    const batch = pendingRef.current;
    pendingRef.current = [];
    dropFromOverlay(batch);
  };

  const paintTap = (userId: string, d: IsoDate) => {
    const w = weekRef.current;
    if (!w || !activeBrush || !guard(d)) return;
    const day = personDay(w, userId, d);
    if (day.locked) {
      showToast(blockedMessage(day), 'error');
      return;
    }
    const key = `${userId}|${d}`;
    setLastKey(key);
    if (needsConfirm(day, activeBrush)) {
      flushPaint();
      openConfirmFor(userId, d, activeBrush, strokeRef.current);
      return;
    }
    pendingRef.current = queuePaint(pendingRef.current, { userId, date: d, action: activeBrush });
    setOverlay((m) => new Map(m).set(key, activeBrush));
    if (paintTimer.current) window.clearTimeout(paintTimer.current);
    paintTimer.current = window.setTimeout(() => latest.current.flushPaint(), PAINT_BATCH_MS);
  };

  const finishPaint = () => {
    flushPaint();
    strokeRef.current = newStroke();
    setLastKey(null);
    setView('day');
  };

  const switchView = (v: View) => {
    if (view === 'paint' && v !== 'paint') {
      flushPaint();
      strokeRef.current = newStroke();
      setLastKey(null);
    }
    setView(v);
  };

  // ---- undo -------------------------------------------------------------------
  const undoLast = () => {
    cancelPaint();
    setToast(null);
    void enqueue(async () => {
      const entry = undoRef.current[undoRef.current.length - 1];
      const w = weekRef.current;
      if (!entry || !w) return;
      setUndoStack((s) => s.filter((e) => e.id !== entry.id));
      // The next paint after an undo starts a fresh stroke.
      strokeRef.current = newStroke();
      const ops = restoreOps(w, entry);
      if (ops.length === 0) {
        showToast('Nothing to undo.');
        return;
      }
      const r = await runPatch({ ops, label: entry.declinedRequest ? 'Undone — the time-off request stays declined' : 'Undone', cells: [], noUndo: true });
      if (r === 'failed') setUndoStack((s) => [...s, entry]);
    });
  };

  const latest = useRef({ applyAction, saveDetail, openConfirmFor, flushPaint });
  latest.current = { applyAction, saveDetail, openConfirmFor, flushPaint };

  // Leaving the screen sends whatever paint is still waiting.
  useEffect(() => {
    const ref = latest;
    return () => ref.current.flushPaint();
  }, []);

  // First load of a week that contains the venue's today: open on today.
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!week || landed.current === week.weekStart) return;
    const first = landed.current === null;
    landed.current = week.weekStart;
    const i = weekDays(week.weekStart).indexOf(venueNow(week.timezone).date);
    if (first && i >= 0) setDayIndex(i);
  }, [week]);

  // ---- navigation -------------------------------------------------------------
  const stepDay = (delta: -1 | 1) => {
    const next = dayIndex + delta;
    if (next < 0 || next > 6) {
      flushPaint();
      onWeekChange(addDays(weekStart, delta * 7));
      setDayIndex(next < 0 ? 6 : 0);
    } else setDayIndex(next);
  };
  const stepWeek = (delta: -1 | 1) => {
    flushPaint();
    onWeekChange(addDays(weekStart, delta * 7));
  };

  // ---- render -----------------------------------------------------------------
  const strip = weekStrip(week, weekStart, date, today);
  const edits = week && week.state === 'published' ? week.shifts.filter((s) => s.editedSincePublish || s.status === 'draft').length + week.leaves.filter((l) => l.status === 'draft').length : 0;
  const stateLabel = !week ? '' : week.state === 'published' ? (edits > 0 ? `Published · ${edits} ${edits === 1 ? 'edit' : 'edits'}` : 'Published') : 'Draft';
  const title = view === 'day' ? longDate(date) : view === 'person' ? 'By person' : 'Week · paint';
  const writesBlocked = !online || offlineSince !== null;
  const selectedPerson = personId && people.some((p) => p.id === personId) ? personId : (people[0]?.id ?? null);

  const sheetShift = sheet?.kind === 'detail' && week ? (week.shifts.find((s) => s.id === sheet.shiftId) ?? null) : null;
  const sheetPerson = sheet?.kind === 'assign' && week ? (week.people.find((p) => p.id === sheet.userId) ?? null) : null;

  return (
    <div className="flex flex-col gap-3" data-testid="manager-phone-rota">
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="eyebrow truncate">{[stateLabel, weekRangeLabel(days[0]!, days[6]!)].filter(Boolean).join(' · ')}</span>
          <h2 className="truncate font-['Instrument_Serif',ui-serif,Georgia,serif] text-[28px] font-normal leading-[1.05]">{title}</h2>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => (view === 'day' ? stepDay(-1) : stepWeek(-1))}
            aria-label={view === 'day' ? 'Previous day' : 'Previous week'}
            className="grid h-11 w-11 place-items-center rounded-full border border-border-strong text-foreground"
          >
            <ChevronLeft aria-hidden="true" className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => (view === 'day' ? stepDay(1) : stepWeek(1))}
            aria-label={view === 'day' ? 'Next day' : 'Next week'}
            className="grid h-11 w-11 place-items-center rounded-full border border-border-strong text-foreground"
          >
            <ChevronRight aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
      </div>

      {view !== 'paint' && (
        <div role="group" aria-label="Week overview" className="grid grid-cols-7 gap-1">
          {strip.map((d, i) => (
            <button
              key={d.date}
              type="button"
              aria-pressed={view === 'day' && d.selected}
              aria-current={d.today ? 'date' : undefined}
              aria-label={d.label}
              onClick={() => {
                setDayIndex(i);
                if (view !== 'day') switchView('day');
              }}
              className={cn(
                'flex min-h-[52px] flex-col items-center gap-0.5 rounded-[10px] border border-transparent py-1.5 tabular-nums',
                d.weekend && 'bg-foreground/[0.03]',
                view === 'day' && d.selected && 'border-accent bg-accent/14',
              )}
            >
              <span className={cn('text-[10px] font-semibold uppercase tracking-[0.06em]', view === 'day' && d.selected ? 'text-accent' : 'text-muted-foreground')}>{d.weekday}</span>
              <span className={cn('text-[15px] font-bold', view === 'day' && d.selected && 'text-accent', d.today && !(view === 'day' && d.selected) && 'underline decoration-accent underline-offset-4')}>{d.day}</span>
              <span className={cn('text-[10px]', d.short ? 'font-bold' : 'text-muted-foreground')} style={d.short ? { color: 'var(--rota-ochre)' } : undefined}>
                {d.count}
              </span>
            </button>
          ))}
        </div>
      )}

      <div role="group" aria-label="View" className="flex gap-0.5 rounded-xl border border-border bg-surface-raised p-[3px]">
        {(['day', 'person', 'paint'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => switchView(v)}
            className={cn('min-h-11 flex-1 rounded-[9px] text-[13px] font-semibold capitalize', view === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}
          >
            {v}
          </button>
        ))}
      </div>

      {(!online || offlineSince) && (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <WifiOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {offlineSince ? `${offlineLabel(offlineSince)} — the published rota as you last saw it. Changes are paused until you are back online.` : OFFLINE_WRITE}
        </p>
      )}

      {loading && !week ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the week">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />
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
        view === 'day' ? (
          <PhoneDayView week={week} date={date} onAssign={openAssign} onShift={(s) => (s.date < today ? showToast('That day has already passed.', 'error') : setSheet({ kind: 'detail', shiftId: s.id }))} />
        ) : view === 'person' ? (
          <PhonePersonView week={week} people={people} personId={selectedPerson} today={today} onPickPerson={setPersonId} onDay={openAssign} />
        ) : activeBrush ? (
          <PhonePaintView
            week={week}
            brush={activeBrush}
            pending={overlay}
            lastKey={lastKey}
            today={today}
            disabled={writesBlocked}
            onBrush={(b) => {
              flushPaint();
              setBrush(b);
            }}
            onPaint={paintTap}
            onUndo={undoLast}
            canUndo={undoStack.length > 0 || overlay.size > 0}
            onDone={finishPaint}
          />
        ) : null
      ) : null}

      <Toast toast={toast} onUndo={undoLast} onDismiss={() => setToast(null)} />

      {sheet?.kind === 'assign' && week && sheetPerson && (
        <AssignSheet
          key={`${sheet.userId}|${sheet.date}`}
          week={week}
          person={sheetPerson}
          shortName={shortName(sheet.userId)}
          day={personDay(week, sheet.userId, sheet.date)}
          disabled={writesBlocked}
          onPick={(a) => pickInSheet(sheet.userId, sheet.date, a)}
          onEditDetails={(() => {
            const s = personDay(week, sheet.userId, sheet.date).shifts[0];
            return s ? () => setSheet({ kind: 'detail', shiftId: s.id }) : null;
          })()}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'detail' && week && sheetShift && (
        <ShiftDetailSheet
          key={sheetShift.id}
          week={week}
          shift={sheetShift}
          people={people}
          personRoleLine={(() => {
            const p = week.people.find((x) => x.id === sheetShift.userId);
            return p ? roleLine(p, week.departments) : '';
          })()}
          disabled={writesBlocked}
          onSave={(edit) => saveDetail(sheetShift, edit)}
          onDuplicate={() => detailAction(sheetShift, 'duplicate')}
          onMakeOpen={() => detailAction(sheetShift, 'open')}
          onDelete={() => detailAction(sheetShift, 'delete')}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'confirm' && <ConfirmSheet content={sheet.content} disabled={writesBlocked} onConfirm={sheet.proceed} onEdit={sheet.edit} onCancel={() => setSheet(null)} />}
    </div>
  );
}
