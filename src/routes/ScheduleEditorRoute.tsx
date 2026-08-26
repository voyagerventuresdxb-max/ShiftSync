import { useMemo, useState } from 'react';
import { CalendarPlus, Clock, Lock, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { weekDates, weekdayOf } from '../engine/rosterView';
import { useAppState } from '../state/AppStateContext';
import { ApiError } from '../api/schedules';

interface RoleOption {
  id: string;
  name: string;
}

export default function ScheduleEditorContent() {
  const {
    weekStart,
    mergedRoster,
    sections,
    staffDirectory,
    createRotaShift,
    updateRotaShift,
    deleteRotaShift,
    currentEmployeeId,
    weekLocked,
    refreshPublishInfo,
  } = useAppState();
  const days = useMemo(() => weekDates(weekStart), [weekStart]);
  const [activeDate, setActiveDate] = useState(days[0]!);
  const [draft, setDraft] = useState<{ id?: string; userId: string | null; roleId: string; start: string; end: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every mutation here goes through the same wrapper: a failed write leaves
  // the sheet open with the server's own message showing, instead of the
  // previous bare `void mutate(...)` + unconditional close, which reported
  // success for a 404/409/500 and left an unhandled rejection behind. Publish
  // status is re-fetched on success because a create/update/delete is exactly
  // what flips the week back to "unpublished changes" — the same contract
  // RotaBuilder honours.
  const run = async (mutate: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await mutate();
      refreshPublishInfo();
      setDraft(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const dayShifts = mergedRoster.shifts.filter((s) => s.date === activeDate).sort((a, b) => a.start.localeCompare(b.start));
  const staffOptions = sections.flatMap((s) => s.employees);

  // Every role a staff member actually holds, deduped by `roleId` — the same
  // directory-derived source RotaBuilder.tsx uses for its own role picker,
  // so a shift created here never drifts from one created there. No new
  // backend endpoint: `staffDirectory` already carries `roleId`/`roleName`.
  const roleOptions = useMemo(() => {
    const byId = new Map<string, RoleOption>();
    for (const s of staffDirectory) {
      if (s.roleId && s.roleName) byId.set(s.roleId, { id: s.roleId, name: s.roleName });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [staffDirectory]);

  return (
    <div className="space-y-5">
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {days.map((d) => (
          <button
            key={d}
            onClick={() => setActiveDate(d)}
            className={cn(
              'min-w-[3.5rem] shrink-0 rounded-xl border px-3 py-2 text-center transition-all',
              activeDate === d ? 'border-accent/40 bg-accent text-accent-foreground shadow-lux' : 'border-border bg-surface text-muted-foreground',
            )}
          >
            <span className="block text-[10px] uppercase">{weekdayOf(d)}</span>
            <span className="block font-semibold">{d.slice(8)}</span>
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {dayShifts.length === 0 && (
          <div className="panel p-6 text-center">
            <p className="text-sm text-muted-foreground">No shifts on {weekdayOf(activeDate)}.</p>
          </div>
        )}
        {dayShifts.map((s) => {
          const person = mergedRoster.employees.find((e) => e.id === s.employeeId);
          return (
            <button
              key={s.id}
              onClick={() => setDraft({ id: s.id, userId: s.employeeId.startsWith('open-') ? null : s.employeeId, roleId: '', start: s.start, end: s.end })}
              className="panel w-full p-4 text-left transition-colors hover:border-accent/40"
            >
              <p className="text-sm font-semibold">{person?.name ?? 'Open shift'}</p>
              <p className="mt-1 inline-flex items-center gap-1.5 text-xs tabular-nums text-foreground/80">
                <Clock className="h-3.5 w-3.5 text-accent" /> {s.start}–{s.end}
              </p>
            </button>
          );
        })}
      </div>

      {weekLocked && (
        <p className="flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          This week is published and locked — publish again from the rota builder after making changes to unlock it.
        </p>
      )}

      <button
        disabled={weekLocked}
        onClick={() => setDraft({ userId: null, roleId: roleOptions[0]?.id ?? '', start: '16:00', end: '23:30' })}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-lux disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CalendarPlus className="h-4 w-4" /> New shift · {weekdayOf(activeDate)}
      </button>

      {draft && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 backdrop-blur-sm sm:items-center">
          <div className="panel w-full max-w-md p-4">
            <div className="grid grid-cols-2 gap-3">
              <input type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} className="rounded-lg border border-border bg-background/60 px-3 py-2 text-sm" />
              <input type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} className="rounded-lg border border-border bg-background/60 px-3 py-2 text-sm" />
            </div>
            <select
              value={draft.userId ?? ''}
              onChange={(e) => setDraft({ ...draft, userId: e.target.value || null })}
              className="mt-3 w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm"
            >
              <option value="">Leave open / unassign</option>
              {staffOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {!draft.id && (
              <select
                value={draft.roleId}
                onChange={(e) => setDraft({ ...draft, roleId: e.target.value })}
                className="mt-3 w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm"
              >
                {roleOptions.length === 0 ? (
                  <option value="">No roles configured</option>
                ) : (
                  roleOptions.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))
                )}
              </select>
            )}
            {error && (
              <div className="error-block mt-3" role="alert">
                <p>{error}</p>
              </div>
            )}
            {weekLocked && (
              <p className="mt-3 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                Locked — this week is published with no pending changes.
              </p>
            )}
            <div className="mt-3 flex gap-2">
              {draft.id && (
                <button
                  disabled={weekLocked || busy}
                  onClick={() => void run(() => deleteRotaShift(draft.id!, currentEmployeeId), 'Could not delete that shift.')}
                  aria-label="Delete shift"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-destructive/30 text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <button
                disabled={weekLocked || busy || (!draft.id && !draft.roleId)}
                onClick={() => {
                  if (draft.id) {
                    void run(
                      () => updateRotaShift(draft.id!, { userId: draft.userId, start: draft.start, end: draft.end, actorId: currentEmployeeId }),
                      'Could not save that shift.',
                    );
                  } else if (draft.roleId) {
                    void run(
                      () => createRotaShift({ roleId: draft.roleId, userId: draft.userId, date: activeDate, start: draft.start, end: draft.end, createdById: currentEmployeeId }),
                      'Could not create that shift.',
                    );
                  }
                }}
                className="flex-1 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {draft.id ? 'Save changes' : 'Publish shift'}
              </button>
              {/* Save/delete used to be the only ways out of this sheet. Now
                  that both can be disabled (locked week, in-flight write), it
                  needs its own exit or the manager is stuck in the modal. */}
              <button
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
                className="shrink-0 rounded-xl border border-border-strong px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
