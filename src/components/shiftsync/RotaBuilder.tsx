import { useCallback, useEffect, useMemo, useState } from 'react';
import { DragDropProvider, useDraggable, useDroppable } from '@dnd-kit/react';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers,
  Lock,
  PencilLine,
  Plus,
  Save,
  Send,
  StickyNote,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { weekDates, weekdayOf } from '@/engine/rosterView';
import { roleKey } from '@/engine/roleGrouping';
import type { Shift } from '@/engine/types';
import { useAppState } from '@/state/AppStateContext';
import { ApiError } from '@/api/schedules';
import {
  fetchRotaTemplates,
  saveRotaTemplate,
  deleteRotaTemplate,
  applyRotaTemplate,
  type RotaTemplateDto,
  type TemplateEntryInput,
} from '@/api/rotaTemplates';
import { fetchWeekShifts } from '@/api/shifts';

/** dnd-kit sensor config, matching FloorPlan/AssignmentBoard.tsx exactly: touch gets a delay so scrolling doesn't start a drag, mouse gets a distance threshold. */
const sensors = [
  PointerSensor.configure({
    activationConstraints(event: PointerEvent) {
      return event.pointerType === 'touch'
        ? [new PointerActivationConstraints.Delay({ value: 500, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 8 })];
    },
  }),
  KeyboardSensor,
];

interface DraftShift {
  id?: string;
  date: string;
  userId: string | null;
  roleId: string;
  roleName: string;
  start: string;
  end: string;
  briefingNote: string;
  sidework: string[];
}

interface RoleOption {
  id: string;
  name: string;
}

type Sheet = { kind: 'shift'; draft: DraftShift } | { kind: 'templates' } | { kind: 'saveTemplate' } | null;

/** The grid's synthetic "unassigned" row — a real drop target so a shift can be pulled off a person without being deleted. */
const OPEN_ROW = 'open';

export function RotaBuilder() {
  const {
    weekStart,
    setWeekStart,
    mergedRoster,
    sections,
    createRotaShift,
    updateRotaShift,
    deleteRotaShift,
    publishCurrentWeek,
    fetchCurrentWeekPublishStatus,
    refetchWeekShifts,
    currentEmployeeId,
  } = useAppState();

  const [cardOpen, setCardOpen] = useState(true);
  const [publishInfo, setPublishInfo] = useState<{ publishedAt: string | null; notifiedCount: number; hasUnpublishedChanges: boolean } | null>(null);
  const [templates, setTemplates] = useState<RotaTemplateDto[]>([]);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [suppressClick, setSuppressClick] = useState(false);

  // `Shift` (engine/types) deliberately carries only a human-readable
  // `requiredRole`, but every write endpoint keys off the DB `roleId`. There
  // is no roles-list endpoint yet (see the report for this task), so the
  // week's raw ShiftDtos are fetched here purely as a role sidecar: they are
  // the only place a real roleId is exposed to the client. `roleOptions`
  // accumulates across visited weeks so an empty week can still be built on
  // roles discovered elsewhere in the session.
  const [dataVersion, setDataVersion] = useState(0);
  const [roleIdByShiftId, setRoleIdByShiftId] = useState<Record<string, string>>({});
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);

  const days = useMemo(() => weekDates(weekStart), [weekStart]);
  const weekShifts = mergedRoster.shifts.filter((s) => days.includes(s.date));

  const bump = () => setDataVersion((v) => v + 1);

  const refreshPublishInfo = useCallback(() => {
    fetchCurrentWeekPublishStatus()
      .then(setPublishInfo)
      .catch(() => setPublishInfo(null));
  }, [fetchCurrentWeekPublishStatus]);

  useEffect(() => {
    refreshPublishInfo();
  }, [refreshPublishInfo]);

  useEffect(() => {
    fetchRotaTemplates('seed-location').then(setTemplates).catch(() => setTemplates([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchWeekShifts('seed-location', weekStart)
      .then((dtos) => {
        if (cancelled) return;
        setRoleIdByShiftId(Object.fromEntries(dtos.map((d) => [d.id, d.roleId])));
        setRoleOptions((prev) => {
          const byId = new Map(prev.map((r) => [r.id, r]));
          for (const d of dtos) byId.set(d.roleId, { id: d.roleId, name: d.roleName });
          return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
        });
      })
      .catch(() => {
        if (!cancelled) setRoleIdByShiftId({});
      });
    return () => {
      cancelled = true;
    };
  }, [weekStart, dataVersion]);

  const say = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3200);
  };

  const fail = (err: unknown, fallback: string) => say(err instanceof ApiError ? err.message : fallback);

  const locked = Boolean(publishInfo?.publishedAt) && !publishInfo?.hasUnpublishedChanges;

  const cellShifts = (date: string, userId: string | null) =>
    weekShifts.filter((s) => s.date === date && (userId === null ? s.employeeId.startsWith('open-') : s.employeeId === userId));

  const openNew = (date: string, userId: string | null) => {
    const employee = mergedRoster.employees.find((e) => e.id === userId);
    const employeeRole = employee?.role ?? '';
    // Pre-select the role option whose name matches this person's own role;
    // fall back to the first known role so the sheet is never unsaveable.
    const guessed = roleOptions.find((r) => roleKey(r.name) === roleKey(employeeRole)) ?? roleOptions[0];
    setSheet({
      kind: 'shift',
      draft: {
        date,
        userId,
        roleId: guessed?.id ?? '',
        roleName: guessed?.name ?? employeeRole,
        start: '16:00',
        end: '23:30',
        briefingNote: '',
        sidework: [],
      },
    });
  };

  const openEdit = (s: Shift) => {
    setSheet({
      kind: 'shift',
      draft: {
        id: s.id,
        date: s.date,
        userId: s.employeeId.startsWith('open-') ? null : s.employeeId,
        roleId: roleIdByShiftId[s.id] ?? '',
        roleName: s.requiredRole ?? '',
        start: s.start,
        end: s.end,
        briefingNote: s.briefingNote ?? '',
        sidework: s.sidework ?? [],
      },
    });
  };

  const saveDraft = async (draft: DraftShift) => {
    if (!draft.roleId && !draft.id) {
      say(roleOptions.length === 0 ? 'No roles are configured for this venue yet.' : 'Pick a role before saving.');
      return;
    }
    try {
      if (draft.id) {
        await updateRotaShift(draft.id, {
          ...(draft.roleId ? { roleId: draft.roleId } : {}),
          userId: draft.userId,
          date: draft.date,
          start: draft.start,
          end: draft.end,
          briefingNote: draft.briefingNote || null,
          sidework: draft.sidework,
          actorId: currentEmployeeId,
        });
      } else {
        await createRotaShift({
          roleId: draft.roleId,
          userId: draft.userId,
          date: draft.date,
          start: draft.start,
          end: draft.end,
          briefingNote: draft.briefingNote || undefined,
          sidework: draft.sidework,
          createdById: currentEmployeeId,
        });
      }
      bump();
      refreshPublishInfo();
      setSheet(null);
    } catch (err) {
      fail(err, 'Could not save that shift.');
    }
  };

  const removeShift = async (id: string) => {
    try {
      await deleteRotaShift(id, currentEmployeeId);
      bump();
      refreshPublishInfo();
      setSheet(null);
    } catch (err) {
      fail(err, 'Could not delete that shift.');
    }
  };

  const moveShift = async (id: string, date: string, userId: string | null) => {
    if (locked) {
      say('This week is published and locked — publish again after making changes to update it.');
      return;
    }
    try {
      await updateRotaShift(id, { date, userId, actorId: currentEmployeeId });
      bump();
      refreshPublishInfo();
    } catch (err) {
      fail(err, 'Could not move that shift.');
    }
  };

  const publish = async () => {
    if (weekShifts.length === 0) {
      say('Add some shifts before publishing this week.');
      return;
    }
    try {
      const result = await publishCurrentWeek(currentEmployeeId);
      bump();
      refreshPublishInfo();
      say(`Rota published — ${result.notifiedCount} staff notified.`);
    } catch (err) {
      fail(err, 'Could not publish this week.');
    }
  };

  // Only shifts whose real roleId is known can become template entries —
  // every template entry is replayed through the same roleId-validating
  // create path when the template is applied.
  const templatableShifts = weekShifts.filter((s) => Boolean(roleIdByShiftId[s.id]));

  const saveWeekAsTemplate = async (name: string) => {
    const entries: TemplateEntryInput[] = templatableShifts.map((s) => ({
      dayOffset: days.indexOf(s.date),
      roleId: roleIdByShiftId[s.id]!,
      userId: s.employeeId.startsWith('open-') ? null : s.employeeId,
      start: s.start,
      end: s.end,
      ...(s.briefingNote ? { note: s.briefingNote } : {}),
    }));
    if (entries.length === 0) {
      say('There are no saveable shifts in this week yet.');
      return;
    }
    try {
      const template = await saveRotaTemplate('seed-location', name, entries, currentEmployeeId);
      setTemplates((prev) => [...prev, template]);
      say(`Saved "${template.name}" — ${entries.length} shifts captured.`);
      setSheet(null);
    } catch (err) {
      fail(err, 'Could not save that template.');
    }
  };

  const rows: { key: string; label: string; flagged?: boolean; people: { id: string; name: string; userId: string | null }[] }[] = [
    ...sections.map((section) => ({
      key: section.key,
      label: section.label,
      flagged: section.flagged,
      people: section.employees.map((e) => ({ id: e.id, name: e.name, userId: e.id as string | null })),
    })),
    { key: OPEN_ROW, label: 'Open shifts', people: [{ id: OPEN_ROW, name: 'Unassigned', userId: null }] },
  ];

  return (
    <section className="panel animate-rise overflow-hidden">
      <button onClick={() => setCardOpen((v) => !v)} aria-expanded={cardOpen} className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-surface-raised/40">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Weekly rota builder</p>
          <p className="truncate text-sm font-semibold tracking-tight">{days[0]} – {days[6]}</p>
        </div>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300', cardOpen && 'rotate-180')} />
      </button>

      {cardOpen && (
        <>
          <header className="flex flex-wrap items-center gap-3 border-y border-border p-4">
            <div className="flex items-center gap-1.5">
              <button onClick={() => setWeekStart(shiftWeek(weekStart, -1))} aria-label="Previous week" className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="px-1 text-sm font-semibold tracking-tight">{weekdayOf(days[0])} {days[0].slice(8)} – {weekdayOf(days[6])} {days[6].slice(8)}</span>
              <button onClick={() => setWeekStart(shiftWeek(weekStart, 1))} aria-label="Next week" className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
              <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium', locked ? 'border-success/25 bg-success/12 text-success' : 'border-warning/25 bg-warning/12 text-warning')}>
                {locked ? <Lock className="h-3 w-3" /> : <PencilLine className="h-3 w-3" />}
                {locked ? 'Published · locked' : publishInfo?.publishedAt ? 'Unpublished changes' : 'Draft'}
              </span>
              <button onClick={() => void publish()} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-foreground transition-transform duration-200 hover:scale-[1.03]">
                <Send className="h-3.5 w-3.5" /> {publishInfo?.publishedAt ? 'Publish changes' : 'Publish & notify'}
              </button>
              <button onClick={() => setSheet({ kind: 'templates' })} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:border-accent/40 hover:text-foreground">
                <Layers className="h-3.5 w-3.5" /> Templates ({templates.length})
              </button>
              <button onClick={() => setSheet({ kind: 'saveTemplate' })} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:border-accent/40 hover:text-foreground">
                <Save className="h-3.5 w-3.5" /> Save as template
              </button>
            </div>
          </header>

          {flash && <p className="border-b border-border/60 bg-accent/10 px-4 py-2 text-xs text-accent">{flash}</p>}

          <DragDropProvider
            sensors={sensors}
            onDragStart={() => setSuppressClick(true)}
            onDragEnd={(event) => {
              // A drag that ends on a chip must not also fire that chip's
              // click handler and pop the edit sheet open (same guard as
              // FloorPlan/AssignmentBoard.tsx).
              setTimeout(() => setSuppressClick(false), 200);
              if (event.canceled) return;
              const shiftId = event.operation.source?.id;
              const target = String(event.operation.target?.id ?? '');
              const [date, rowId] = target.split('|');
              if (typeof shiftId !== 'string' || !date) return;
              void moveShift(shiftId, date, !rowId || rowId === OPEN_ROW ? null : rowId);
            }}
          >
            <div className="overflow-x-auto">
              <div className="min-w-[860px]">
                <div className="grid grid-cols-[10rem_repeat(7,minmax(0,1fr))] border-b border-border bg-background/40">
                  <div className="p-3 eyebrow">Staff</div>
                  {days.map((d) => (
                    <div key={d} className="p-2.5 text-center text-xs font-medium">{weekdayOf(d)} {d.slice(8)}</div>
                  ))}
                </div>

                {rows.map((row) => (
                  <div key={row.key}>
                    <div className={cn('border-b border-border/60 bg-surface-raised/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em]', row.flagged ? 'text-warning' : 'text-muted-foreground')}>
                      {row.label}
                    </div>
                    {row.people.map((person) => (
                      <div key={person.id} className="grid grid-cols-[10rem_repeat(7,minmax(0,1fr))] border-b border-border/60">
                        <div className="flex items-center gap-2 p-3 text-sm font-medium">
                          {person.userId === null && <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                          <span className="truncate">{person.name}</span>
                        </div>
                        {days.map((d) => (
                          <Cell
                            key={d}
                            date={d}
                            userId={person.userId}
                            shifts={cellShifts(d, person.userId)}
                            onAdd={() => openNew(d, person.userId)}
                            onEdit={openEdit}
                            locked={locked}
                            suppressClick={suppressClick}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </DragDropProvider>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
            <p className="text-[11px] text-muted-foreground">{weekShifts.length} shifts this week</p>
          </footer>
        </>
      )}

      {sheet?.kind === 'shift' && (
        <ShiftSheet
          draft={sheet.draft}
          roleOptions={roleOptions}
          onClose={() => setSheet(null)}
          onSave={(d) => void saveDraft(d)}
          onDelete={(id) => void removeShift(id)}
        />
      )}
      {sheet?.kind === 'templates' && (
        <TemplateSheet
          templates={templates}
          onClose={() => setSheet(null)}
          onApply={async (t) => {
            try {
              const result = await applyRotaTemplate(t.id, weekStart, currentEmployeeId);
              await refetchWeekShifts();
              bump();
              refreshPublishInfo();
              say(`Applied "${t.name}" — ${result.createdCount} shifts created.`);
              setSheet(null);
            } catch (err) {
              fail(err, 'Could not apply that template.');
            }
          }}
          onDelete={async (id) => {
            try {
              await deleteRotaTemplate(id);
              setTemplates((prev) => prev.filter((t) => t.id !== id));
            } catch (err) {
              fail(err, 'Could not delete that template.');
            }
          }}
        />
      )}
      {sheet?.kind === 'saveTemplate' && (
        <SaveTemplateSheet
          shiftCount={templatableShifts.length}
          skippedCount={weekShifts.length - templatableShifts.length}
          onClose={() => setSheet(null)}
          onSave={(name) => void saveWeekAsTemplate(name)}
        />
      )}
    </section>
  );
}

function shiftWeek(weekStart: string, deltaWeeks: number): string {
  const d = new Date(`${weekStart}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaWeeks * 7);
  return d.toISOString().slice(0, 10);
}

/**
 * One draggable shift chip. dnd-kit registers a drag source through the
 * `useDraggable` hook's returned `ref` — never through a native `draggable`
 * attribute or a DOM `id` — so this mirrors FloorPlan/StaffChip.tsx exactly.
 * `touch-none` is required for the pointer sensor to own the gesture on
 * touch devices.
 */
function ShiftChip({
  shift,
  locked,
  suppressClick,
  onEdit,
}: {
  shift: Shift;
  locked: boolean;
  suppressClick: boolean;
  onEdit: (s: Shift) => void;
}) {
  const { ref, isDragging } = useDraggable({ id: shift.id, disabled: locked });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        if (!suppressClick) onEdit(shift);
      }}
      className={cn(
        'block w-full touch-none select-none rounded-md border border-accent/30 bg-accent/12 px-1.5 py-1 text-left text-[10px] leading-tight transition-transform hover:scale-[1.03]',
        !locked && 'cursor-grab',
        isDragging && 'border-accent opacity-50',
      )}
    >
      <span className="block font-semibold">{shift.start}–{shift.end}</span>
      {shift.briefingNote && (
        <span className="mt-0.5 flex items-center gap-1 truncate text-muted-foreground">
          <StickyNote className="h-2.5 w-2.5 shrink-0" /> {shift.briefingNote}
        </span>
      )}
    </button>
  );
}

/**
 * One day/staff grid cell. Like the chips above, the drop target is
 * registered through `useDroppable`'s returned `ref` (see
 * FloorPlan/SectionOverlay.tsx) — the `date|rowId` key is the hook's `id`,
 * not a DOM attribute, and is parsed back out in `onDragEnd`.
 */
function Cell({
  date,
  userId,
  shifts,
  onAdd,
  onEdit,
  locked,
  suppressClick,
}: {
  date: string;
  userId: string | null;
  shifts: Shift[];
  onAdd: () => void;
  onEdit: (s: Shift) => void;
  locked: boolean;
  suppressClick: boolean;
}) {
  const { ref, isDropTarget } = useDroppable({ id: `${date}|${userId ?? OPEN_ROW}` });
  return (
    <div
      ref={ref}
      className={cn(
        'min-h-[64px] space-y-1 border-l border-border/40 p-1.5 transition-colors',
        isDropTarget && 'bg-accent/10 ring-1 ring-inset ring-accent/40',
      )}
    >
      {shifts.map((s) => (
        <ShiftChip key={s.id} shift={s} locked={locked} suppressClick={suppressClick} onEdit={onEdit} />
      ))}
      {!locked && (
        <button onClick={onAdd} aria-label={`Add shift on ${date}`} className="grid h-6 w-full place-items-center rounded-md border border-dashed border-border-strong text-muted-foreground hover:border-accent hover:text-accent">
          <Plus className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function SheetShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-background/70 p-3 backdrop-blur-sm sm:p-6">
      <div className="panel w-full max-w-lg shadow-lux">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-border bg-surface/95 p-4 backdrop-blur">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

const field = 'min-w-0 w-full rounded-lg border border-input bg-background/60 px-3 py-2 text-sm focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring';
const label = 'mb-1 block text-[11px] font-medium text-muted-foreground';

function ShiftSheet({
  draft,
  roleOptions,
  onClose,
  onSave,
  onDelete,
}: {
  draft: DraftShift;
  roleOptions: RoleOption[];
  onClose: () => void;
  onSave: (d: DraftShift) => void;
  onDelete: (id: string) => void;
}) {
  const [local, setLocal] = useState(draft);
  const [sideworkText, setSideworkText] = useState(draft.sidework.join(', '));

  return (
    <SheetShell title={draft.id ? 'Edit shift' : 'New shift'} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <span className={label}>Role</span>
          {roleOptions.length === 0 ? (
            <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">
              No roles found for this venue yet — add a shift through an uploaded roster first.
            </p>
          ) : (
            <select
              value={local.roleId}
              onChange={(e) => {
                const roleId = e.target.value;
                setLocal({ ...local, roleId, roleName: roleOptions.find((r) => r.id === roleId)?.name ?? local.roleName });
              }}
              className={field}
            >
              <option value="">Select a role…</option>
              {roleOptions.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>Start</span>
            <input type="time" value={local.start} onChange={(e) => setLocal({ ...local, start: e.target.value })} className={field} />
          </div>
          <div>
            <span className={label}>End</span>
            <input type="time" value={local.end} onChange={(e) => setLocal({ ...local, end: e.target.value })} className={field} />
          </div>
        </div>
        <div>
          <span className={label}>Briefing note (visible to staff)</span>
          <textarea value={local.briefingNote} onChange={(e) => setLocal({ ...local, briefingNote: e.target.value })} rows={2} placeholder="e.g. VIP table 12 · brief at 15:45" className={cn(field, 'resize-none')} />
        </div>
        <div>
          <span className={label}>Sidework (comma-separated)</span>
          <input
            value={sideworkText}
            onChange={(e) => {
              setSideworkText(e.target.value);
              setLocal({ ...local, sidework: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) });
            }}
            placeholder="Polish glassware, Restock ice"
            className={field}
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={() => onSave(local)} className="flex-1 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition-transform hover:scale-[1.02]">
            <Check className="mr-1.5 inline h-4 w-4" /> {draft.id ? 'Save shift' : 'Add shift'}
          </button>
          {draft.id && (
            <button onClick={() => onDelete(draft.id!)} aria-label="Delete shift" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-destructive/30 text-destructive hover:bg-destructive/10">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </SheetShell>
  );
}

function TemplateSheet({
  templates,
  onClose,
  onApply,
  onDelete,
}: {
  templates: RotaTemplateDto[];
  onClose: () => void;
  onApply: (t: RotaTemplateDto) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <SheetShell title="Rota templates" onClose={onClose}>
      {templates.length === 0 ? (
        <p className="text-xs text-muted-foreground">No templates yet.</p>
      ) : (
        <ul className="space-y-2">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{t.name}</p>
                <p className="text-[11px] text-muted-foreground">{t.entryCount} shifts</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button onClick={() => onApply(t)} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground">Apply</button>
                <button onClick={() => onDelete(t.id)} aria-label="Delete template" className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SheetShell>
  );
}

/** Captures the currently-visible week as a reusable, weekday-relative pattern. */
function SaveTemplateSheet({
  shiftCount,
  skippedCount,
  onClose,
  onSave,
}: {
  shiftCount: number;
  skippedCount: number;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const trimmed = name.trim();

  return (
    <SheetShell title="Save week as template" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Captures {shiftCount} shift{shiftCount === 1 ? '' : 's'} from this week as day-of-week offsets, so the pattern can be applied to any future week.
        </p>
        {skippedCount > 0 && (
          <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            {skippedCount} shift{skippedCount === 1 ? '' : 's'} will be skipped — no role on record for {skippedCount === 1 ? 'it' : 'them'}.
          </p>
        )}
        <div>
          <span className={label}>Template name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Standard weekend cover"
            className={field}
          />
        </div>
        <button
          onClick={() => onSave(trimmed)}
          disabled={!trimmed || shiftCount === 0}
          className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
        >
          <Save className="mr-1.5 inline h-4 w-4" /> Save template
        </button>
      </div>
    </SheetShell>
  );
}
