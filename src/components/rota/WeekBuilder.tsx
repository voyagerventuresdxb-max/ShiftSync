import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropProvider } from '@dnd-kit/react';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { ChevronLeft, ChevronRight, Copy, Layers, MessageSquare, Mic, Redo2, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { offlineLabel } from '@/lib/offlineCache';
import { useIdentity } from '@/state/IdentityContext';
import { useConnectivity } from '@/state/ConnectivityContext';
import { useAppState } from '@/state/AppStateContext';
import { useWeekDoc } from '@/state/useWeekDoc';
import { emitRosterChanged, fetchWeekDoc } from '@/api/weeks';
import { venueReadHeaders } from '@/api/venueBinding';
import { decideTimeOff } from '@/api/rotaSetup';
import { OfflineActionNotice } from '@/components/shiftsync/OfflineNotice';
import { LEAVE_LABELS, addDays, formatRange, mondayOf, weekDays, type IsoDate, type LeaveTypeCode, type WeekDocDto, type WeekPatchOp, type WeekRequestDto, type WeekShiftDto } from '../../../shared/rotaWeek';
import { weekRangeLabel } from '@/engine/weekMath';
import {
  activeTypes,
  cellId,
  cellOf,
  classifyDrop,
  dayMonth,
  fullDate,
  groupPeople,
  indexWeek,
  leaveLabel,
  moveFocus,
  parseCellId,
  roleLine,
  shiftLabel,
  shortDay,
  shortNames,
  typeName,
  unpublishedCount,
  venueToday,
  type DragSource,
  type FocusPos,
} from '@/engine/rotaGrid';
import { aliasesFrom, afterRedo, afterUndo, emptyHistory, invertOps, recordAction, remapOps, type History } from '@/engine/rotaUndo';
import { bulkSummary, copyCells, moveOps, openShiftOps, placeOps, planBulk, planPaste, roleForDepartment, type CellContent, type ClipCell } from '@/engine/rotaPlans';
import { readClock, readCoachDone, readDensity, readRequestsOpen, writeClock, writeCoachDone, writeDensity, writeRequestsOpen, type Density } from './prefs';
import { useMediaQuery } from './useMediaQuery';
import { DISPLAY, btn } from './Dialog';
import { Dock } from './Dock';
import { WeekGrid, type GridDrag } from './WeekGrid';
import { RequestsStrip, type StripAction } from './RequestsStrip';
import { ConfirmSheet, type ConfirmDetails } from './ConfirmSheet';
import { ShiftSheet, type SheetSubmit, type ShiftSheetMode } from './ShiftSheet';
import { ShiftTypeEditor } from './ShiftTypeEditor';
import { PublishFlow } from './PublishFlow';
import { StaleWeekDialog } from './StaleWeekDialog';
import { CopyWeekDialog } from './CopyWeekDialog';
import { TemplatesDialog } from './TemplatesDialog';
import { BulkBar } from './BulkBar';
import { Coach, EmptyWeekPrompt, GridSkeleton, NoShiftTypes } from './EmptyStates';

/**
 * Rota builder v2 — the manager's week builder for tablet and desktop
 * (Design boards B1, B2, B4–B6, B8; Spec §1, §2, §4, §6, §7). Built on
 * `useWeekDoc`: the week document is the only roster truth on screen, and
 * every change — a drop, a number key, a sheet, bulk, copy, a template, an
 * undo — is ONE `patch({ ops })`. Mounted lazily by the Scheduling tab for
 * managers at ≥ 768 px, so dnd-kit never reaches the staff bundle.
 */

export interface WeekBuilderProps {
  locationId: string;
  weekStart: string;
  onWeekChange: (weekStart: string) => void;
}

/**
 * The sensors the old builder and the floor plan share (touch: 500 ms
 * long-press with 5 px tolerance, so scrolling wins; mouse: 8 px), plus the
 * keyboard sensor. Two keyboard changes, both for the grid's keyboard map:
 * only Space lifts (Enter opens the shift sheet), and one arrow press moves
 * the lifted chip one cell rather than 10 px.
 */
function sensorsFor(cell: { w: number; h: number }) {
  return [
    PointerSensor.configure({
      activationConstraints(event: PointerEvent) {
        return event.pointerType === 'touch'
          ? [new PointerActivationConstraints.Delay({ value: 500, tolerance: 5 })]
          : [new PointerActivationConstraints.Distance({ value: 8 })];
      },
    }),
    KeyboardSensor.configure({
      offset: { x: cell.w, y: cell.h },
      keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ['Space'] },
    }),
  ];
}

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'warn' | 'error';
  undo?: boolean;
}

type Overlay =
  | { kind: 'confirm'; details: ConfirmDetails; onConfirm: () => Promise<void>; onCancel: () => void; onEdit?: () => void }
  | { kind: 'sheet'; mode: ShiftSheetMode }
  | { kind: 'types' }
  | { kind: 'publish' }
  | { kind: 'copy' }
  | { kind: 'templates' }
  | null;

const SAFE_VERSION = Number.MAX_SAFE_INTEGER;

/** The person-day a drag source is about, for announcements. */
function sourceLabel(week: WeekDocDto, source: DragSource): string {
  if (source.kind === 'type') return typeName(source.shiftTypeId, week.shiftTypes);
  if (source.kind === 'status') return LEAVE_LABELS[source.leaveType];
  const s = week.shifts.find((x) => x.id === source.shiftId);
  return s ? typeName(s.shiftTypeId, week.shiftTypes) : 'Shift';
}

function asSource(data: unknown, copy: boolean): DragSource | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.kind === 'type' && typeof d.shiftTypeId === 'string') return { kind: 'type', shiftTypeId: d.shiftTypeId };
  if (d.kind === 'status' && typeof d.leaveType === 'string' && Object.hasOwn(LEAVE_LABELS, d.leaveType)) return { kind: 'status', leaveType: d.leaveType as LeaveTypeCode };
  if (d.kind === 'shift' && typeof d.shiftId === 'string') return { kind: 'shift', shiftId: d.shiftId, copy };
  return null;
}

export default function WeekBuilder({ locationId, weekStart, onWeekChange }: WeekBuilderProps) {
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const { venueName, handleDecideRequest } = useAppState();
  const token = session?.token ?? null;
  const doc = useWeekDoc({ locationId, weekStart, sessionToken: token, offlineUserId: session?.user.id ?? null });
  const week = doc.week;
  const weekRef = useRef<WeekDocDto | null>(week);
  weekRef.current = week;

  const tablet = useMediaQuery('(max-width: 899px)');
  const [density, setDensity] = useState<Density>(readDensity);
  const [clockPref, setClockPref] = useState(readClock);
  const [requestsOpen, setRequestsOpen] = useState(readRequestsOpen);
  const [coach, setCoach] = useState(() => !readCoachDone());
  const clock = clockPref ?? week?.clock ?? '24h';

  const [history, setHistory] = useState<History>(emptyHistory);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [toast, setToast] = useState<Toast | null>(null);
  const [live, setLive] = useState('');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  const [activeTray, setActiveTray] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<GridDrag | null>(null);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [clipboard, setClipboard] = useState<ClipCell[]>([]);
  const [lastWeekSummary, setLastWeekSummary] = useState<{ shifts: number; people: number } | null>(null);
  const [cellSize, setCellSize] = useState({ w: 124, h: 64 });
  const busyRef = useRef(false);
  const justDragged = useRef(false);
  const altDown = useRef(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const today = useMemo(() => venueToday(week?.timezone ?? 'Asia/Dubai'), [week?.timezone]);
  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const idx = useMemo(() => (week ? indexWeek(week) : new Map()), [week]);
  const groups = useMemo(() => (week ? groupPeople(week) : []), [week]);
  const types = useMemo(() => (week ? activeTypes(week.shiftTypes) : []), [week]);
  const names = useMemo(() => shortNames(week?.people ?? []), [week]);
  const readOnly = !online || !!doc.offlineSince || !token;
  const sensors = useMemo(() => sensorsFor(cellSize), [cellSize]);

  // Visible row order for focus movement and paste.
  const layout = useMemo(() => {
    const rows: (string | null)[] = [];
    const groupStarts: number[] = [];
    for (const g of groups) {
      if (collapsed[g.id]) continue;
      groupStarts.push(rows.length);
      rows.push(...g.people.map((p) => p.id));
    }
    if (!collapsed.open) {
      groupStarts.push(rows.length);
      rows.push(null);
    }
    return { rows, groupStarts };
  }, [groups, collapsed]);
  const personRows = useMemo(() => layout.rows.filter((r): r is string => r !== null), [layout]);

  // ------------------------------------------------------------------
  // Messages: toast + live region
  // ------------------------------------------------------------------
  const toastSeq = useRef(0);
  const say = useCallback((message: string, tone: Toast['tone'] = 'info', undo = false) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, message, tone, undo });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.tone === 'error' ? 8000 : 6000);
    return () => window.clearTimeout(t);
  }, [toast]);
  const announce = useCallback((msg: string) => {
    // A changed string re-announces even when the words repeat.
    setLive((prev) => (prev === msg ? `${msg} ` : msg));
  }, []);

  // ------------------------------------------------------------------
  // Week change / publish resets (Spec §2: undo stack and selection cleared; density kept)
  // ------------------------------------------------------------------
  useEffect(() => {
    setHistory(emptyHistory());
    setSelection(new Set());
    setHighlight(new Set());
    setActiveTray(null);
    setFocusId(null);
    setLastSaved(null);
    setLastWeekSummary(null);
  }, [weekStart]);

  // Measure one cell so a keyboard arrow moves a lifted chip exactly one cell.
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const cell = el.querySelector<HTMLElement>('[role="gridcell"][data-cell]');
      if (!cell) return;
      const r = cell.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setCellSize((cur) => (Math.abs(cur.w - r.width) < 1 && Math.abs(cur.h - r.height) < 1 ? cur : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [week !== null, density, tablet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Alt / ⌥ held during a drag copies instead of moving (B2 state 6).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altDown.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altDown.current = false;
    };
    const blur = () => {
      altDown.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Empty week: what last week had, for the "Start from last week?" prompt.
  const isEmptyWeek = !!week && week.shifts.length === 0 && week.leaves.length === 0;
  useEffect(() => {
    if (!isEmptyWeek || !token) return;
    let cancelled = false;
    fetchWeekDoc(locationId, addDays(weekStart, -7), venueReadHeaders(token, null))
      .then((prev) => {
        if (!cancelled) setLastWeekSummary({ shifts: prev.shifts.length, people: new Set(prev.shifts.map((s) => s.userId).filter(Boolean)).size });
      })
      .catch(() => {
        if (!cancelled) setLastWeekSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isEmptyWeek, token, locationId, weekStart]);

  // ------------------------------------------------------------------
  // Writes: every change is ONE patch; its inverse goes on the undo stack
  // ------------------------------------------------------------------
  const apply = useCallback(
    async (ops: WeekPatchOp[], label: string, opts: { override?: boolean; undoable?: boolean } = {}): Promise<boolean> => {
      const before = weekRef.current;
      if (!before) return false;
      if (!online) {
        say("Requires connection — try again once you're back online.", 'warn');
        return false;
      }
      if (ops.length === 0) return true;
      if (busyRef.current) {
        say('Still saving the last change…', 'warn');
        return false;
      }
      busyRef.current = true;
      try {
        const res = await doc.patch({ ops, ...(opts.override ? { overridePendingRequests: true } : {}), note: label });
        if (res.result === 'ok') {
          const inverse = invertOps(before, ops, res.results);
          if (opts.undoable !== false) setHistory((h) => recordAction(h, { label, ops: inverse }));
          setLastSaved(new Date());
          const declined = res.declinedRequestIds.length;
          say(
            declined ? `${label} · ${declined === 1 ? 'request' : `${declined} requests`} declined (undo keeps ${declined === 1 ? 'it' : 'them'} declined)` : label,
            'info',
            opts.undoable !== false && inverse.length > 0,
          );
          announce(label);
          return true;
        }
        if (res.result === 'refused') {
          say(res.message, 'error');
          announce(res.message);
          return false;
        }
        // version_conflict: `doc.conflict` now holds the newer week; the stale dialog explains.
        announce('Someone else changed this week. Your change was not applied.');
        return false;
      } catch (err) {
        say(err instanceof Error ? err.message : 'Could not save that change.', 'error');
        return false;
      } finally {
        busyRef.current = false;
      }
    },
    [online, doc.patch, say, announce], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const runHistory = useCallback(
    async (direction: 'undo' | 'redo') => {
      const h = historyRef.current;
      const entry = direction === 'undo' ? h.undo[h.undo.length - 1] : h.redo[h.redo.length - 1];
      const before = weekRef.current;
      if (!entry || !before) {
        announce(direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
        return;
      }
      if (!online) {
        say("Requires connection — try again once you're back online.", 'warn');
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      const ops = remapOps(entry.ops, h.alias);
      try {
        const res = await doc.patch({ ops, note: `${direction === 'undo' ? 'Undo' : 'Redo'}: ${entry.label}` });
        if (res.result === 'ok') {
          const alias = aliasesFrom(ops, res.results);
          const back = { label: entry.label, ops: invertOps(before, ops, res.results) };
          setHistory((cur) => (direction === 'undo' ? afterUndo(cur, back, alias) : afterRedo(cur, back, alias)));
          setLastSaved(new Date());
          const msg = `${direction === 'undo' ? 'Undone' : 'Redone'} · ${entry.label}`;
          say(msg);
          announce(msg);
        } else if (res.result === 'refused') {
          say(`Couldn't ${direction}: ${res.message}`, 'error');
        }
      } catch (err) {
        say(err instanceof Error ? err.message : `Could not ${direction}.`, 'error');
      } finally {
        busyRef.current = false;
      }
    },
    [online, doc.patch, say, announce], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const runHistoryRef = useRef(runHistory);
  runHistoryRef.current = runHistory;

  const personOf = useCallback((userId: string | null) => (userId ? weekRef.current?.people.find((p) => p.id === userId) : undefined), []);
  const who = useCallback((userId: string | null) => (userId ? (names.get(userId) ?? 'Someone') : 'Open shifts'), [names]);

  /** Confirm sheet as a promise: resolves true when the confirmed write succeeded. */
  const ask = useCallback(
    (details: ConfirmDetails, write: () => Promise<boolean>, onEdit?: () => void) =>
      new Promise<boolean>((resolve) => {
        setOverlay({
          kind: 'confirm',
          details,
          onConfirm: async () => {
            const ok = await write();
            setOverlay(null);
            resolve(ok);
          },
          onCancel: () => {
            setOverlay(null);
            resolve(false);
          },
          onEdit: onEdit
            ? () => {
                resolve(false);
                onEdit();
              }
            : undefined,
        });
      }),
    [],
  );

  const requestConsequence = (r: WeekRequestDto) => `Declines ${personOf(r.userId)?.fullName.split(/\s+/)[0] ?? 'their'}’s request`;

  // ------------------------------------------------------------------
  // Placing things on cells (drop, number key, dock tap)
  // ------------------------------------------------------------------
  const place = useCallback(
    async (source: DragSource, target: { date: IsoDate; userId: string | null }): Promise<boolean> => {
      const w = weekRef.current;
      if (!w) return false;
      const index = indexWeek(w);
      const verdict = classifyDrop({ week: w, idx: index, today }, source, target);
      if (verdict.state === 'noop') return false;
      if (verdict.state === 'invalid') {
        announce(verdict.message);
        say(verdict.message, 'warn');
        return false;
      }
      if (verdict.state === 'blocked') {
        say(verdict.message, 'warn');
        announce(verdict.message);
        return false;
      }
      const day = shortDay(target.date);
      let ops: WeekPatchOp[] = [];
      let label = '';
      if (source.kind === 'shift') {
        const s = w.shifts.find((x) => x.id === source.shiftId);
        if (!s) return false;
        ops = moveOps(w, index, s, target, !!source.copy);
        label = source.copy ? `Copied ${typeName(s.shiftTypeId, w.shiftTypes)} → ${who(target.userId)} · ${day}` : `Moved ${who(s.userId)} → ${who(target.userId)} · ${day}`;
      } else if (target.userId === null) {
        if (source.kind !== 'type') return false;
        const dept = w.departments.length === 1 ? w.departments[0]!.id : (w.departments[0]?.id ?? null);
        const pick = async (departmentId: string | null) => {
          const roleId = roleForDepartment(w, departmentId);
          if (!roleId) {
            say('Add a role to this venue first (People), so the open shift can be filed under it.', 'warn');
            return false;
          }
          return apply(openShiftOps({ date: target.date, roleId, departmentId, content: { kind: 'type', shiftTypeId: source.shiftTypeId } }), `Open ${typeName(source.shiftTypeId, w.shiftTypes)} · ${day}`);
        };
        if (w.departments.length > 1) {
          // Ambiguous department: the shift sheet asks (Spec §4 "Open-shift drops ask which department").
          setOverlay({ kind: 'sheet', mode: { kind: 'new', date: target.date, userId: null } });
          return false;
        }
        return pick(dept);
      } else {
        const content: CellContent = source.kind === 'type' ? { kind: 'type', shiftTypeId: source.shiftTypeId } : { kind: 'leave', type: source.leaveType };
        const r = placeOps(w, cellOf(index, target.date, target.userId), content, { today, allowPending: true });
        if (r.skip) {
          say(r.skip === 'noRole' ? `${who(target.userId)} has no role yet. Give them one in People first.` : 'That cell cannot take it.', 'warn');
          return false;
        }
        ops = r.ops;
        label = `${source.kind === 'type' ? typeName(source.shiftTypeId, w.shiftTypes) : LEAVE_LABELS[source.leaveType]} · ${who(target.userId)} → ${day}${verdict.replaces ? ` (was ${verdict.replaces.split(' ')[0]})` : ''}`;
      }
      if (verdict.state === 'confirm') {
        const p = personOf(target.userId);
        const shiftSrc = source.kind === 'shift' ? w.shifts.find((x) => x.id === source.shiftId) : undefined;
        const t = source.kind === 'type' ? w.shiftTypes.find((x) => x.id === source.shiftTypeId) : undefined;
        const times = shiftSrc ? shiftLabel(shiftSrc, w.shiftTypes, clock) : t ? `${t.name} · ${t.ranges.map((r) => formatRange(r, clock)).join(' · ')}` : null;
        return ask(
          {
            personName: p?.fullName ?? null,
            initials: p?.initials,
            roleLine: p ? [w.departments.find((d) => d.id === p.departmentId)?.name, roleLine(p, w.departments)].filter(Boolean).join(' · ') : null,
            dateLine: fullDate(target.date),
            timesLine: times,
            replaces: verdict.replaces,
            consequences: [requestConsequence(verdict.request)],
          },
          () => apply(ops, label, { override: true }),
          () => setOverlay({ kind: 'sheet', mode: { kind: 'new', date: target.date, userId: target.userId } }),
        );
      }
      return apply(ops, label);
    },
    [today, apply, ask, announce, say, who, personOf, clock], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ------------------------------------------------------------------
  // Focus, selection
  // ------------------------------------------------------------------
  const posOf = useCallback(
    (id: string): FocusPos | null => {
      const p = parseCellId(id);
      if (!p) return null;
      const row = layout.rows.indexOf(p.userId);
      const col = days.indexOf(p.date);
      return row < 0 || col < 0 ? null : { row, col };
    },
    [layout, days],
  );
  const idAt = useCallback((pos: FocusPos) => cellId(days[pos.col]!, layout.rows[pos.row] ?? null), [days, layout]);
  const focusCell = useCallback((id: string) => {
    setFocusId(id);
    window.requestAnimationFrame(() => {
      const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(id)}"]`);
      el?.focus({ preventScroll: false });
    });
  }, []);

  const rangeBetween = useCallback(
    (a: string, b: string): string[] => {
      const pa = posOf(a);
      const pb = posOf(b);
      if (!pa || !pb) return [b];
      const out: string[] = [];
      for (let r = Math.min(pa.row, pb.row); r <= Math.max(pa.row, pb.row); r++) for (let c = Math.min(pa.col, pb.col); c <= Math.max(pa.col, pb.col); c++) out.push(idAt({ row: r, col: c }));
      return out;
    },
    [posOf, idAt],
  );

  const onCellClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      setFocusId(id);
      if (e.shiftKey && anchorRef.current) {
        setSelection(new Set(rangeBetween(anchorRef.current, id)));
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        anchorRef.current = id;
        setSelection((cur) => {
          const next = new Set(cur);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }
      anchorRef.current = id;
      setSelection(new Set());
      const p = parseCellId(id);
      const w = weekRef.current;
      if (!p || !w) return;
      if (readOnly || p.date < today) return;
      const c = cellOf(indexWeek(w), p.date, p.userId);
      if (c.shifts.length === 0 || p.userId === null) setOverlay({ kind: 'sheet', mode: { kind: 'new', date: p.date, userId: p.userId } });
    },
    [rangeBetween, readOnly, today],
  );

  const onChipOpen = useCallback((shiftId: string) => {
    if (justDragged.current) return;
    const s = weekRef.current?.shifts.find((x) => x.id === shiftId);
    if (s) setOverlay({ kind: 'sheet', mode: { kind: 'edit', shift: s } });
  }, []);

  const selectRow = useCallback(
    (userId: string | null, additive: boolean) => {
      const ids = days.map((d) => cellId(d, userId));
      setSelection((cur) => new Set([...(additive ? cur : []), ...ids]));
    },
    [days],
  );
  const selectColumn = useCallback(
    (date: IsoDate, additive: boolean) => {
      const ids = personRows.map((u) => cellId(date, u));
      setSelection((cur) => new Set([...(additive ? cur : []), ...ids]));
    },
    [personRows],
  );

  const showCells = useCallback((cells: string[]) => {
    const first = cells[0];
    if (!first) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => gridRef.current?.querySelector(`[data-cell="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' }));
  }, []);

  const jumpToCoverage = useCallback(
    (date: IsoDate) => {
      setCollapsed((c) => ({ ...c, open: false }));
      const id = cellId(date, null);
      setHighlight(new Set([id]));
      showCells([id]);
    },
    [showCells],
  );

  // ------------------------------------------------------------------
  // Bulk, copy / paste, clear
  // ------------------------------------------------------------------
  const selectedCells = useMemo(() => [...selection].map(parseCellId).filter((x): x is { date: IsoDate; userId: string | null } => x !== null), [selection]);

  const runBulk = useCallback(
    async (content: CellContent, verb: string, cells = selectedCells) => {
      const w = weekRef.current;
      if (!w) return;
      const plan = planBulk(w, cells, content, today);
      if (plan.ops.length === 0) {
        say(plan.applied ? 'Nothing to change.' : bulkSummary(plan, verb), 'warn');
        return;
      }
      const ok = await apply(plan.ops, bulkSummary(plan, verb));
      if (ok) setSelection(new Set());
    },
    [selectedCells, today, apply, say],
  );

  const copySelection = useCallback(() => {
    const w = weekRef.current;
    if (!w) return;
    const cells = selectedCells.length ? selectedCells : focusId ? [parseCellId(focusId)].filter((x): x is { date: IsoDate; userId: string | null } => x !== null) : [];
    const clip = copyCells(w, cells, personRows);
    setClipboard(clip);
    say(clip.length ? `Copied ${clip.length} cell${clip.length === 1 ? '' : 's'} · ⌘V / Ctrl V on a cell to paste` : 'Select person cells to copy.');
  }, [selectedCells, focusId, personRows, say]);

  const paste = useCallback(async () => {
    const w = weekRef.current;
    if (!w || !focusId || clipboard.length === 0) {
      if (clipboard.length === 0) say('Nothing copied yet.');
      return;
    }
    const p = parseCellId(focusId);
    if (!p || p.userId === null) return;
    const plan = planPaste(w, clipboard, { row: personRows.indexOf(p.userId), day: days.indexOf(p.date) }, personRows, today);
    if (plan.ops.length === 0) {
      say(bulkSummary(plan, 'Pasted'), 'warn');
      return;
    }
    await apply(plan.ops, bulkSummary(plan, 'Pasted'));
  }, [focusId, clipboard, personRows, days, today, apply, say]);

  // ------------------------------------------------------------------
  // Keyboard (Spec §2 keyboard map)
  // ------------------------------------------------------------------
  const toggleRequests = useCallback(() => {
    setRequestsOpen((o) => {
      writeRequestsOpen(!o);
      return !o;
    });
  }, []);
  const setDensityPref = useCallback((d: Density) => {
    setDensity(d);
    writeDensity(d);
  }, []);
  const jumpToday = useCallback(() => {
    const monday = mondayOf(today);
    if (monday !== weekStart) {
      onWeekChange(monday);
      return;
    }
    const first = layout.rows[0];
    if (first !== undefined) focusCell(cellId(today, first));
  }, [today, weekStart, onWeekChange, layout, focusCell]);

  const lift = useCallback(
    (id: string) => {
      const cell = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(id)}"]`);
      const chip = cell?.querySelector<HTMLElement>('[data-chip]');
      if (!chip || readOnly) {
        announce(readOnly ? 'Changes are paused offline' : 'Nothing to lift here');
        return;
      }
      // The keyboard sensor listens on the chip (the draggable); the cell is the tab stop.
      chip.focus();
      chip.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
    },
    [readOnly, announce],
  );

  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.defaultPrevented || drag) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea, [contenteditable="true"]')) return;
      const id = target.closest<HTMLElement>('[data-cell]')?.dataset.cell ?? focusId;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key;
      if (!id) return;
      const pos = posOf(id);
      if (!pos) return;
      const p = parseCellId(id)!;

      if (!mod) {
        const next = moveFocus(pos, key, { rows: layout.rows.length, cols: 7, groupStarts: layout.groupStarts });
        if (next) {
          e.preventDefault();
          const nid = idAt(next);
          if (e.shiftKey && key.startsWith('Arrow')) {
            if (!anchorRef.current) anchorRef.current = id;
            setSelection(new Set(rangeBetween(anchorRef.current, nid)));
          }
          focusCell(nid);
          return;
        }
      }
      if (!mod && !e.altKey) {
        if (/^[0-9]$/.test(key)) {
          e.preventDefault();
          if (readOnly) return say("Requires connection — try again once you're back online.", 'warn');
          if (key === '0') {
            if (p.userId === null) return announce("An open shift can't be a day off");
            void place({ kind: 'status', leaveType: 'DAY_OFF' }, p);
            return;
          }
          const t = types[Number(key) - 1];
          if (!t) return announce(`No shift type ${key}`);
          void place({ kind: 'type', shiftTypeId: t.id }, p);
          return;
        }
        if (key === 'Delete' || key === 'Backspace') {
          e.preventDefault();
          void runBulk({ kind: 'clear' }, 'Cleared', selectedCells.length ? selectedCells : [p]);
          return;
        }
        if (key === 'Enter') {
          e.preventDefault();
          const w = weekRef.current;
          if (!w) return;
          const c = cellOf(indexWeek(w), p.date, p.userId);
          if (c.shifts[0] && p.userId !== null) setOverlay({ kind: 'sheet', mode: { kind: 'edit', shift: c.shifts[0] } });
          else if (!readOnly && p.date >= today) setOverlay({ kind: 'sheet', mode: { kind: 'new', date: p.date, userId: p.userId } });
          return;
        }
        if (key === ' ') {
          e.preventDefault();
          lift(id);
          return;
        }
        if (key === 'Escape') {
          setSelection(new Set());
          setHighlight(new Set());
          return;
        }
        const k = key.toLowerCase();
        if (k === 'r' || k === 'd' || k === 't') {
          e.preventDefault();
          if (k === 'r') toggleRequests();
          else if (k === 'd') setDensityPref(density === 'compact' ? 'comfortable' : 'compact');
          else jumpToday();
          return;
        }
      }
      if (mod && !e.shiftKey) {
        const k = key.toLowerCase();
        if (k === 'a') {
          e.preventDefault();
          const g = [...layout.groupStarts].reverse().find((s) => s <= pos.row) ?? 0;
          const end = layout.groupStarts.find((s) => s > pos.row) ?? layout.rows.length;
          const ids: string[] = [];
          for (let r = g; r < end; r++) for (const d of days) ids.push(cellId(d, layout.rows[r] ?? null));
          setSelection(new Set(ids));
        } else if (k === 'c') {
          e.preventDefault();
          copySelection();
        } else if (k === 'v') {
          e.preventDefault();
          void paste();
        }
      }
    },
    [drag, focusId, posOf, layout, idAt, rangeBetween, focusCell, readOnly, say, announce, place, types, runBulk, selectedCells, today, lift, toggleRequests, setDensityPref, density, jumpToday, days, copySelection, paste],
  );

  // ⌘Z / ⌘⇧Z / ⌘P anywhere on the page while the builder is open (not in inputs, not under a dialog or the voice sheet).
  const overlayOpen = overlay !== null || coach || doc.conflict !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen || document.querySelector('main[inert]')) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void runHistoryRef.current('undo');
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        void runHistoryRef.current('redo');
      } else if (k === 'p') {
        e.preventDefault();
        setOverlay({ kind: 'publish' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayOpen]);

  // ------------------------------------------------------------------
  // Requests strip actions (time off + swaps): API, then every surface refetches
  // ------------------------------------------------------------------
  const rosterMoved = useCallback(
    (versions?: Record<string, number>) => {
      const entries = versions && Object.keys(versions).length ? Object.entries(versions) : [[weekStart, SAFE_VERSION] as [string, number]];
      // An unknown new version is sent as the largest one: every listener on that week refetches.
      for (const [ws, v] of entries) emitRosterChanged({ locationId, weekStart: ws, version: v });
      if (!versions || !versions[weekStart]) void doc.refetch();
    },
    [locationId, weekStart, doc],
  );

  const onStripAction = useCallback(
    (a: StripAction) => {
      const w = weekRef.current;
      if (!w || !token) return;
      const r = a.request;
      const p = personOf(r.userId);
      const inWeek = r.dates.filter((d) => days.includes(d));
      const dateLine = inWeek.length > 1 ? `${fullDate(inWeek[0]!).replace(/ \d{4}$/, '')} – ${fullDate(inWeek[inWeek.length - 1]!)}` : fullDate(inWeek[0] ?? r.dates[0] ?? weekStart);
      const base = {
        personName: p?.fullName ?? 'Someone',
        initials: p?.initials,
        roleLine: p ? roleLine(p, w.departments) : null,
        dateLine,
      };
      const first = p?.fullName.split(/\s+/)[0] ?? 'They';
      if (a.kind === 'approveTimeOff' || a.kind === 'declineTimeOff') {
        const approve = a.kind === 'approveTimeOff';
        const index = indexWeek(w);
        const affected = inWeek.filter((d) => cellOf(index, d, r.userId).shifts.length > 0).length;
        void ask(
          {
            ...base,
            eyebrow: approve ? 'Approve time off' : 'Decline time off',
            timesLine: approve ? leaveLabel('ANNUAL_LEAVE') : 'Time off declined',
            consequences: approve
              ? [...(affected ? [`${affected} shift${affected === 1 ? '' : 's'} become open shifts`] : []), `${first} is told`]
              : [`${first}’s request is declined and they are told`],
            confirmLabel: approve ? 'Approve' : 'Decline request',
            danger: !approve,
          },
          async () => {
            try {
              const res = await decideTimeOff(token, r.id, { decision: approve ? 'approve' : 'decline' });
              if (res.result === 'ok') {
                rosterMoved(res.versions);
                say(`${approve ? 'Approved' : 'Declined'} · ${first}’s time off`);
                return true;
              }
              say(res.message, 'error');
              void doc.refetch();
              return false;
            } catch (err) {
              say(err instanceof Error ? err.message : 'Could not decide that request.', 'error');
              return false;
            }
          },
        );
        return;
      }
      const approve = a.kind === 'approveSwap';
      const target = personOf(r.targetUserId ?? null);
      void ask(
        {
          ...base,
          eyebrow: approve ? 'Approve swap' : 'Decline swap',
          timesLine: `${first} ↔ ${target?.fullName.split(/\s+/)[0] ?? 'cover'}`,
          consequences: approve ? ['The two shifts change hands', 'Both people are told'] : [`${first} is told`],
          confirmLabel: approve ? 'Approve swap' : 'Decline swap',
          danger: !approve,
        },
        async () => {
          try {
            await handleDecideRequest(r.id, approve ? 'approved' : 'denied');
            rosterMoved();
            say(`${approve ? 'Swap approved' : 'Swap declined'} · ${first}`);
            return true;
          } catch (err) {
            say(err instanceof Error ? err.message : 'Could not decide that swap.', 'error');
            return false;
          }
        },
      );
    },
    [token, personOf, days, weekStart, ask, rosterMoved, say, doc, handleDecideRequest],
  );

  // ------------------------------------------------------------------
  // Sheet submit / delete
  // ------------------------------------------------------------------
  const onSheetSubmit = useCallback(
    async (s: SheetSubmit): Promise<boolean> => {
      const w = weekRef.current;
      if (!w) return false;
      const pending = s.target?.userId ? cellOf(indexWeek(w), s.target.date, s.target.userId).pendingRequest : null;
      if (pending && s.target) {
        const p = personOf(s.target.userId);
        return ask(
          {
            personName: p?.fullName ?? null,
            initials: p?.initials,
            roleLine: p ? roleLine(p, w.departments) : null,
            dateLine: fullDate(s.target.date),
            timesLine: s.label,
            consequences: [requestConsequence(pending)],
          },
          () => apply(s.ops, s.label, { override: true }),
        );
      }
      return apply(s.ops, s.label);
    },
    [apply, ask, personOf], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onDeleteShift = useCallback(
    (shift: WeekShiftDto) => {
      const w = weekRef.current;
      if (!w) return;
      const p = personOf(shift.userId);
      void ask(
        {
          eyebrow: 'Delete shift',
          personName: p?.fullName ?? 'Open shift',
          initials: p?.initials ?? '+',
          roleLine: p ? roleLine(p, w.departments) : null,
          dateLine: fullDate(shift.date),
          timesLine: shiftLabel(shift, w.shiftTypes, clock),
          consequences: shift.status === 'published' && p ? [`${p.fullName.split(/\s+/)[0]} is told when you publish`] : [],
          confirmLabel: 'Delete shift',
          danger: true,
        },
        () => apply([{ op: 'delete', shiftId: shift.id }], `Deleted ${typeName(shift.shiftTypeId, w.shiftTypes)} · ${who(shift.userId)} · ${shortDay(shift.date)}`),
      );
    },
    [ask, apply, personOf, who, clock],
  );

  const openVoice = useCallback(() => {
    const entry = document.querySelector<HTMLButtonElement>('[data-voice-entry]');
    if (entry && !entry.disabled) entry.click();
    else say('Voice is busy or unavailable right now.', 'warn');
  }, [say]);

  // ------------------------------------------------------------------
  // Drag and drop
  // ------------------------------------------------------------------
  const dragHandlers = {
    onDragStart: (event: { operation: { source: { data?: unknown } | null } }) => {
      justDragged.current = true;
      const w = weekRef.current;
      const source = asSource(event.operation.source?.data, altDown.current);
      if (!w || !source) return;
      setDrag({ source, overId: null, verdict: null });
      announce(`Picked up ${sourceLabel(w, source)}`);
    },
    onDragOver: (event: { operation: { target: { id: unknown } | null } }) => {
      const w = weekRef.current;
      const overId = event.operation.target?.id;
      setDrag((cur) => {
        if (!cur || !w) return cur;
        const t = typeof overId === 'string' ? parseCellId(overId) : null;
        if (!t) return { ...cur, overId: null, verdict: null };
        const source: DragSource = cur.source.kind === 'shift' ? { ...cur.source, copy: altDown.current } : cur.source;
        const verdict = classifyDrop({ week: w, idx: indexWeek(w), today }, source, t);
        return { source, overId: overId as string, verdict };
      });
      const t = typeof overId === 'string' ? parseCellId(overId) : null;
      if (t && w) {
        const c = cellOf(indexWeek(w), t.date, t.userId);
        const what = c.shifts[0] ? typeName(c.shifts[0].shiftTypeId, w.shiftTypes) : c.leave ? leaveLabel(c.leave.type) : 'empty';
        announce(`${who(t.userId)}, ${dayMonth(t.date)}, ${what}`);
      }
    },
    onDragEnd: (event: { canceled: boolean; nativeEvent?: Event; operation: { source: { data?: unknown } | null; target: { id: unknown } | null } }) => {
      window.setTimeout(() => {
        justDragged.current = false;
      }, 200);
      setDrag(null);
      const w = weekRef.current;
      if (event.canceled || !w) {
        announce('Cancelled');
        return;
      }
      const native = event.nativeEvent;
      const copy = altDown.current || (native instanceof MouseEvent && native.altKey);
      const source = asSource(event.operation.source?.data, copy);
      const overId = event.operation.target?.id;
      const target = typeof overId === 'string' ? parseCellId(overId) : null;
      if (!source || !target) return;
      void place(source, target).then(() => {
        if (native instanceof KeyboardEvent) focusCell(cellId(target.date, target.userId));
      });
    },
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  const weekLabel = weekRangeLabel(days[0]!, days[6]!);
  const pendingCount = week ? week.requests.filter((r) => r.status === 'pending' && r.dates.some((d) => days.includes(d))).length : 0;
  const changes = week ? unpublishedCount(week) : 0;
  const published = !!week?.publishedAt;
  const canUndo = history.undo.length > 0;
  const canRedo = history.redo.length > 0;
  const noTypes = !!week && types.length === 0;

  const header = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-accent/50 bg-surface-raised text-sm font-bold text-accent">
          {(venueName ?? 'S').charAt(0).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="eyebrow truncate">{venueName ? `${venueName} · Scheduling` : 'Scheduling'}</span>
          <span className={cn(DISPLAY, 'text-[28px] leading-[1.05]')}>Week grid</span>
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <button type="button" onClick={() => onWeekChange(addDays(weekStart, -7))} aria-label="Previous week" className={cn(btn.base, btn.ghost, 'w-11 px-0')}>
          <ChevronLeft aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
        <span data-testid="rota-week-label" className="px-1 text-[15px] font-semibold tabular-nums">
          {weekLabel}
        </span>
        <button type="button" onClick={() => onWeekChange(addDays(weekStart, 7))} aria-label="Next week" className={cn(btn.base, btn.ghost, 'w-11 px-0')}>
          <ChevronRight aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
        {mondayOf(today) !== weekStart && (
          <button type="button" onClick={jumpToday} className={cn(btn.base, btn.sm, btn.plain, 'ms-1')}>
            Today
          </button>
        )}
      </div>
      <div className="flex-1" />
      <div className="flex flex-wrap items-center gap-2">
        {week && (
          <div role="status" className="flex min-h-9 items-center gap-2 whitespace-nowrap rounded-[10px] border border-border-strong px-3 text-xs">
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', published ? 'bg-success' : 'border border-dashed border-muted-foreground')} />
            <span className="font-bold">{published ? 'Published' : 'Draft'}</span>
            {changes > 0 && <span className="font-semibold text-accent">{published ? `${changes} change${changes === 1 ? '' : 's'}` : `${week.shifts.length} shift${week.shifts.length === 1 ? '' : 's'}`}</span>}
            {lastSaved && !tablet && <span className="text-muted-foreground">saved {lastSaved.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        )}
        <button
          type="button"
          onClick={() => setOverlay({ kind: 'publish' })}
          disabled={!week || readOnly || (published && !week.hasUnpublishedChanges) || week.shifts.length + week.leaves.length === 0}
          className={cn(btn.base, btn.gold)}
        >
          {published ? (week?.hasUnpublishedChanges ? (changes > 0 ? `Publish ${changes} change${changes === 1 ? '' : 's'}` : 'Publish changes') : 'Published') : 'Publish week'}
        </button>
        <button
          type="button"
          onClick={openVoice}
          aria-label="Voice: build or change shifts by speaking"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-accent/55 bg-accent/10 text-accent shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_8%,transparent)] hover:bg-accent/15"
        >
          <Mic aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>
    </div>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => setOverlay({ kind: 'copy' })} disabled={!week || readOnly || noTypes} className={cn(btn.base, btn.sm, btn.plain)}>
        <Copy aria-hidden="true" className="h-4 w-4" /> Copy last week
      </button>
      <button type="button" onClick={() => setOverlay({ kind: 'templates' })} disabled={!week || readOnly} className={cn(btn.base, btn.sm, btn.plain)}>
        <Layers aria-hidden="true" className="h-4 w-4" /> Templates
      </button>
      <button type="button" onClick={() => void runHistory('undo')} disabled={!canUndo || readOnly} aria-label={canUndo ? `Undo ${history.undo[history.undo.length - 1]!.label}` : 'Undo'} className={cn(btn.base, btn.sm, btn.plain, 'w-9 px-0')}>
        <Undo2 aria-hidden="true" className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => void runHistory('redo')} disabled={!canRedo || readOnly} aria-label={canRedo ? `Redo ${history.redo[history.redo.length - 1]!.label}` : 'Redo'} className={cn(btn.base, btn.sm, btn.plain, 'w-9 px-0')}>
        <Redo2 aria-hidden="true" className="h-4 w-4" />
      </button>
      <div className="flex-1" />
      <Segmented
        label="Density"
        value={density}
        options={[
          ['comfortable', 'Comfortable'],
          ['compact', 'Compact'],
        ]}
        onChange={(v) => setDensityPref(v as Density)}
      />
      <Segmented
        label="Clock"
        value={clock}
        options={[
          ['12h', '12 h'],
          ['24h', '24 h'],
        ]}
        onChange={(v) => {
          const c = v === '12h' ? '12h' : '24h';
          setClockPref(c);
          writeClock(c);
        }}
      />
      <button type="button" onClick={toggleRequests} aria-expanded={requestsOpen} className={cn(btn.base, btn.sm, btn.plain)}>
        <MessageSquare aria-hidden="true" className="h-4 w-4" /> Requests {pendingCount > 0 && <span className="text-accent">{pendingCount}</span>}
      </button>
    </div>
  );

  return (
    <section aria-label="Week builder" className="flex flex-col gap-2.5">
      {header}
      {readOnly && (
        <div data-testid="rota-offline-notice">
          {doc.offlineSince ? (
            <p role="status" className="text-xs text-warning">
              {offlineLabel(doc.offlineSince)} — the published rota as you last saw it. Changes are paused until you are back online.
            </p>
          ) : (
            <OfflineActionNotice />
          )}
        </div>
      )}
      {toolbar}

      {!week ? (
        doc.error ? (
          <div className="error-block" role="alert">
            <p>{doc.error}</p>
            <button type="button" className="btn btn-ghost" onClick={() => void doc.refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <GridSkeleton />
        )
      ) : (
        <DragDropProvider sensors={sensors} onDragStart={dragHandlers.onDragStart} onDragOver={dragHandlers.onDragOver} onDragEnd={dragHandlers.onDragEnd}>
          {noTypes ? (
            <NoShiftTypes disabled={readOnly} onAdd={() => setOverlay({ kind: 'types' })} onImport={() => document.getElementById('roster-import')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
          ) : (
            <Dock types={types} clock={clock} disabled={readOnly} onEditTypes={() => setOverlay({ kind: 'types' })} onPick={(source, label) => {
              const p = focusId ? parseCellId(focusId) : null;
              if (!p) {
                say(`Focus a cell first, or drag ${label} onto the grid.`);
                return;
              }
              void place(source, p);
            }} />
          )}
          {requestsOpen && (
            <RequestsStrip
              week={week}
              idx={idx}
              names={names}
              active={activeTray}
              disabled={readOnly}
              onHighlight={(key, cells) => {
                setActiveTray(key);
                setHighlight(new Set(cells));
                showCells(cells);
              }}
              onAction={onStripAction}
            />
          )}
          {drag?.verdict && drag.verdict.state !== 'noop' && (
            <p aria-hidden="true" className={cn('text-xs font-medium', drag.verdict.state === 'ok' ? 'text-success' : drag.verdict.state === 'invalid' ? 'text-destructive' : 'text-warning')}>
              {drag.verdict.state === 'ok'
                ? `${drag.source.kind === 'shift' ? (drag.source.copy ? 'Copy' : 'Move') : 'Place'} · ${sourceLabel(week, drag.source)}${drag.verdict.replaces ? ` · replaces ${drag.verdict.replaces}` : ''}`
                : drag.verdict.state === 'confirm'
                  ? `${who(drag.verdict.request.userId)} asked for this day off (pending). Drop to place anyway — you confirm, and the request is declined.`
                  : drag.verdict.message}
            </p>
          )}
          <WeekGrid
            week={week}
            idx={idx}
            groups={groups}
            collapsed={collapsed}
            onToggleGroup={(id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}
            days={days}
            today={today}
            clock={clock}
            compact={density === 'compact'}
            tablet={tablet}
            readOnly={readOnly || noTypes}
            dimmed={noTypes}
            focusId={focusId ?? (layout.rows.length ? cellId(days.includes(today) ? today : days[0]!, layout.rows[0] ?? null) : null)}
            selection={selection}
            highlight={highlight}
            drag={drag}
            onCellClick={onCellClick}
            onCellFocus={setFocusId}
            onChipOpen={onChipOpen}
            onKeyDown={onGridKeyDown}
            onSelectRow={selectRow}
            onSelectColumn={selectColumn}
            onCoverageJump={jumpToCoverage}
            prompt={
              isEmptyWeek && !noTypes ? (
                <EmptyWeekPrompt lastWeek={lastWeekSummary} disabled={readOnly} onCopy={() => setOverlay({ kind: 'copy' })} onTemplate={() => setOverlay({ kind: 'templates' })} onVoice={openVoice} />
              ) : undefined
            }
            gridRef={gridRef}
          />
        </DragDropProvider>
      )}

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {live}
      </div>

      {selection.size > 0 && week && (
        <BulkBar
          count={selection.size}
          description={(() => {
            const ds = new Set(selectedCells.map((c) => c.date));
            const ps = new Set(selectedCells.map((c) => c.userId));
            return `${ds.size} day${ds.size === 1 ? '' : 's'} · ${ps.size} ${ps.size === 1 ? 'row' : 'rows'}`;
          })()}
          types={types}
          disabled={readOnly}
          onApply={(shiftTypeId) => void runBulk({ kind: 'type', shiftTypeId }, 'Applied to')}
          onDayOff={() => void runBulk({ kind: 'leave', type: 'DAY_OFF' }, 'Day off on')}
          onCopy={copySelection}
          onClear={() => void runBulk({ kind: 'clear' }, 'Cleared')}
          onCancel={() => setSelection(new Set())}
        />
      )}

      {toast && (
        <div className={cn('pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4', selection.size > 0 ? 'bottom-44' : 'bottom-24')}>
          <div
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex max-w-xl items-center gap-3 rounded-xl border bg-surface-raised py-2 pe-2.5 ps-3 text-[13px] font-medium shadow-lux',
              toast.tone === 'error' ? 'border-destructive/50' : toast.tone === 'warn' ? 'border-[color-mix(in_oklab,var(--rota-ochre)_60%,transparent)]' : 'border-border-strong',
            )}
          >
            <span>{toast.message}</span>
            {toast.undo && canUndo && (
              <button type="button" onClick={() => void runHistory('undo')} className={cn(btn.base, btn.sm, btn.ghost, 'text-accent')}>
                Undo
              </button>
            )}
            {toast.undo && !tablet && <span className="whitespace-nowrap rounded-[5px] border border-border-strong px-1.5 text-[11px] font-bold text-muted-foreground">⌘Z / Ctrl Z</span>}
            <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className={cn(btn.base, btn.sm, btn.ghost, 'w-9 px-0')}>
              ×
            </button>
          </div>
        </div>
      )}

      {week && overlay?.kind === 'sheet' && (
        <ShiftSheet key={overlay.mode.kind === 'edit' ? overlay.mode.shift.id : `${overlay.mode.date}|${overlay.mode.userId}`} week={week} idx={idx} mode={overlay.mode} today={today} online={!readOnly} onSubmit={onSheetSubmit} onDelete={onDeleteShift} onClose={() => setOverlay(null)} />
      )}
      {overlay?.kind === 'confirm' && <ConfirmSheet details={overlay.details} onConfirm={overlay.onConfirm} onCancel={overlay.onCancel} onEdit={overlay.onEdit} disabled={readOnly} disabledReason={readOnly ? <OfflineActionNotice /> : undefined} />}
      {week && token && overlay?.kind === 'types' && <ShiftTypeEditor week={week} locationId={locationId} token={token} online={!readOnly} onChanged={() => rosterMoved()} onClose={() => setOverlay(null)} />}
      {week && overlay?.kind === 'publish' && (
        <PublishFlow
          week={week}
          venueName={venueName}
          online={!readOnly}
          preview={doc.preview}
          publish={doc.publish}
          onPublished={() => setHistory(emptyHistory())}
          onClose={() => setOverlay(null)}
          onNextWeek={() => {
            setOverlay(null);
            onWeekChange(addDays(weekStart, 7));
          }}
          onFindCover={(date) => {
            setOverlay(null);
            jumpToCoverage(date);
          }}
        />
      )}
      {week && token && overlay?.kind === 'copy' && <CopyWeekDialog week={week} locationId={locationId} token={token} today={today} online={!readOnly} onApply={(ops, label) => apply(ops, label)} onClose={() => setOverlay(null)} />}
      {week && token && session && overlay?.kind === 'templates' && (
        <TemplatesDialog
          week={week}
          locationId={locationId}
          token={token}
          actorId={session.user.id}
          today={today}
          online={!readOnly}
          onApply={(ops, label) => apply(ops, label)}
          onServerApplied={(message) => {
            rosterMoved();
            say(message);
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {week && doc.conflict && (
        <StaleWeekDialog
          mine={week}
          theirs={doc.conflict}
          onReload={() => {
            doc.acceptServerWeek();
            setHistory(emptyHistory());
            say('Week reloaded. Make your change again on top of it.');
          }}
        />
      )}
      {week && coach && !overlay && !doc.conflict && (
        <Coach
          onDone={() => {
            writeCoachDone();
            setCoach(false);
          }}
        />
      )}
    </section>
  );
}

function Segmented(props: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div role="group" aria-label={props.label} className="inline-flex shrink-0 gap-0.5 rounded-[10px] border border-border bg-surface-raised p-[3px]">
      {props.options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={props.value === v}
          onClick={() => props.onChange(v)}
          className={cn('hit-44 min-h-[34px] whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold', props.value === v ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
