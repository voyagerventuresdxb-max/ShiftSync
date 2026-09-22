import { useEffect, useMemo, useState } from 'react';
import { Award, Plus, Trash2, X } from 'lucide-react';
import { deleteShoutout, fetchShoutouts, postShoutout, type ShoutoutDto } from '@/api/shoutouts';
import { ApiError } from '@/api/schedules';
import { useAppState } from '@/state/AppStateContext';
import { useIdentity } from '@/state/IdentityContext';
import { useConnectivity } from '@/state/ConnectivityContext';
import { StaleDataNotice, OfflineEmptyState } from '@/components/shiftsync/OfflineNotice';
import { weekdayOf } from '@/engine/rosterView';

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

function timeAgo(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function Shoutouts() {
  const { locationId, mergedRoster } = useAppState();
  const { session } = useIdentity();
  const { online } = useConnectivity();
  const [items, setItems] = useState<ShoutoutDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True when the most recent load attempt failed — distinguishes an
  // offline cold-load empty state from a genuine "no shoutouts" one.
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Same reasoning as Announcements.tsx (this component's two hosts, Home
    // and My Shifts, are both session-optional) — no locationId means no
    // real venue to load shoutouts for.
    if (!locationId) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchShoutouts(locationId)
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setError(null);
        setLoadFailed(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // `items` is left untouched (Phase 2 of the offline-support pass: a
        // failed reload must not blank out data already on screen). Both
        // fire together: `error` surfaces a genuine (non-connectivity)
        // failure the same way a post-action failure does below, while
        // `loadFailed` drives the offline-specific empty state when the
        // list is also empty.
        setError(err instanceof ApiError ? err.message : 'Could not load shoutouts.');
        setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const shiftsForEmployee = useMemo(
    () => mergedRoster.shifts.filter((s) => s.employeeId === employeeId).sort((a, b) => b.date.localeCompare(a.date)),
    [mergedRoster.shifts, employeeId],
  );

  async function submit() {
    if (!employeeId || !shiftId || !note.trim()) return;
    // Guards on `session`, not `locationId` — see the matching comment in
    // Announcements.tsx's `save()` for why this changed with the
    // kiosk-access fork resolution (2026-08-31, MEMORY.md).
    if (!session || !locationId) {
      setError('You must be signed in to give a shoutout.');
      return;
    }
    const shift = mergedRoster.shifts.find((s) => s.id === shiftId);
    const snapshot = shift ? `${weekdayOf(shift.date)} · ${shift.start}–${shift.end} · ${shift.requiredRole ?? ''}`.trim() : undefined;
    setSaving(true);
    setError(null);
    try {
      const created = await postShoutout(session.token, {
        locationId,
        employeeId,
        shiftSnapshot: snapshot,
        note: note.trim(),
      });
      setItems((prev) => [created, ...prev]);
      setOpen(false);
      setEmployeeId('');
      setShiftId('');
      setNote('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the shoutout.');
    } finally {
      setSaving(false);
    }
  }

  // Anyone signed in may post a shoutout; removing one is manager/owner only,
  // no author exception (server-enforced — this only hides a control that
  // would 403). Positive check so an unexpected role string fails closed.
  const canModerate = session?.user.systemRole === 'MANAGER' || session?.user.systemRole === 'OWNER';

  async function remove(id: string) {
    if (!session) return;
    setError(null);
    try {
      await deleteShoutout(session.token, id);
      setItems((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the shoutout.');
    }
  }

  return (
    <section className="panel animate-rise p-4 sm:p-5">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Recognition</p>
          <h2 className="truncate text-base font-semibold tracking-tight">Shoutouts</h2>
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/20"
        >
          {open ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {open ? 'Close' : 'Tag a shift'}
        </button>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        Tied to the colleague and the exact shift — appears in their shift history.
      </p>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {open && (
        <div className="mt-4 space-y-3 rounded-xl border border-accent/25 bg-accent/5 p-3">
          <label className="block">
            <span className="eyebrow">Colleague</span>
            <select
              value={employeeId}
              onChange={(e) => {
                setEmployeeId(e.target.value);
                setShiftId('');
              }}
              className="mt-1 w-full rounded-lg border border-input bg-background/60 px-3 py-2 text-sm focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select team member…</option>
              {mergedRoster.employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name} · {e.role}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="eyebrow">Shift</span>
            <select
              value={shiftId}
              onChange={(e) => setShiftId(e.target.value)}
              disabled={!employeeId}
              className="mt-1 w-full rounded-lg border border-input bg-background/60 px-3 py-2 text-sm focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-40"
            >
              <option value="">{employeeId ? (shiftsForEmployee.length ? 'Select a shift…' : 'No assigned shifts yet') : 'Pick a colleague first'}</option>
              {shiftsForEmployee.map((s) => (
                <option key={s.id} value={s.id}>{s.date} · {s.start}–{s.end}</option>
              ))}
            </select>
          </label>

          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did they do brilliantly on that shift?"
            className="w-full resize-none rounded-lg border border-input bg-background/60 p-3 text-sm placeholder:text-muted-foreground focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={() => void submit()}
            disabled={!employeeId || !shiftId || !note.trim() || saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Award className="h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Give shoutout'}
          </button>
        </div>
      )}

      {!online && items.length > 0 && <StaleDataNotice />}

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading shoutouts…</p>
      ) : items.length === 0 ? (
        !online && loadFailed ? (
          <OfflineEmptyState message="You're offline — shoutouts couldn't be loaded yet." />
        ) : (
          <p className="mt-4 rounded-xl border border-border p-4 text-center text-sm text-muted-foreground">No shoutouts yet — recognise someone's shift.</p>
        )
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((s) => (
            <li key={s.id} className="rounded-xl border border-border bg-background/40 p-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-[11px] font-semibold text-accent">
                  {initials(s.employeeName)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{s.employeeName}</p>
                  <p className="text-sm text-muted-foreground">{s.note}</p>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {s.shiftSnapshot ?? 'Shift no longer on the rota'} · {s.authorName ?? 'Manager'} · {timeAgo(s.createdAt)}
                  </p>
                </div>
                {canModerate && (
                  <button
                    onClick={() => void remove(s.id)}
                    aria-label="Delete shoutout"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border transition-colors hover:border-destructive/50 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
