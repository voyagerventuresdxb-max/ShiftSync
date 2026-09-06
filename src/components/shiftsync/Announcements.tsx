import { useEffect, useState } from 'react';
import { Megaphone, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  fetchAnnouncements,
  postAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  type AnnouncementDto,
} from '@/api/announcements';
import { useAppState } from '@/state/AppStateContext';
import { useIdentity } from '@/state/IdentityContext';

/** "3h ago" / "2d ago" — coarse, matches the reference design's tone. */
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function Announcements() {
  const { locationId, currentEmployeeId, mergedRoster } = useAppState();
  const { session } = useIdentity();
  const [items, setItems] = useState<AnnouncementDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id: string | null; body: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Neither Home nor My Shifts (this component's two hosts) requires a
    // session — with none, there's no real venue to load announcements for,
    // so show the empty state rather than fetching against a hardcoded id.
    if (!locationId) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchAnnouncements(locationId)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load announcements.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  async function save() {
    if (!draft || !draft.body.trim()) return;
    // Guards on `session`, not `locationId`: since the kiosk-access fork
    // resolution (2026-08-31, see MEMORY.md), `locationId` alone no longer
    // implies a real signed-in user — an anonymous kiosk visit to Home can
    // have a non-null `locationId` via the venue-binding mechanism, and this
    // error copy's own promise ("must be signed in") has to actually hold.
    if (!draft.id && !session) {
      setError('You must be signed in to post an announcement.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (draft.id) {
        const updated = await updateAnnouncement(draft.id, draft.body.trim());
        setItems((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      } else {
        const created = await postAnnouncement(locationId!, draft.body.trim(), currentEmployeeId);
        setItems((prev) => [created, ...prev]);
      }
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the announcement.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await deleteAnnouncement(id);
      setItems((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the announcement.');
    }
  }

  const authorName = (a: AnnouncementDto) =>
    a.authorName ?? mergedRoster.employees.find((e) => e.id === currentEmployeeId)?.name ?? 'Management';

  return (
    <section className="panel animate-rise p-4 sm:p-5">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Broadcast · one-way</p>
          <h2 className="truncate text-base font-semibold tracking-tight">Announcements</h2>
        </div>
        <button
          onClick={() => setDraft({ id: null, body: '' })}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
        >
          <Plus className="h-3.5 w-3.5" /> Post
        </button>
      </header>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      {draft && (
        <div className="mt-4 rounded-xl border border-accent/25 bg-accent/5 p-3">
          <textarea
            autoFocus
            rows={3}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="Share an update with the whole venue…"
            className="w-full resize-none rounded-lg border border-input bg-background/60 p-3 text-sm placeholder:text-muted-foreground focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => setDraft(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={!draft.body.trim() || saving}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? 'Saving…' : draft.id ? 'Save edit' : 'Broadcast'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading announcements…</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((a) => (
            <li key={a.id} className="rounded-xl border border-border bg-background/40 p-3">
              <div className="flex min-w-0 items-start gap-3">
                <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed">{a.body}</p>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {authorName(a)} · {formatStamp(a.createdAt)} · {timeAgo(a.createdAt)}
                    {a.editedAt ? ` · edited ${timeAgo(a.editedAt)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => setDraft({ id: a.id, body: a.body })}
                    aria-label="Edit announcement"
                    className="grid h-7 w-7 place-items-center rounded-lg border border-border transition-colors hover:border-accent/50 hover:text-accent"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => void remove(a.id)}
                    aria-label="Delete announcement"
                    className="grid h-7 w-7 place-items-center rounded-lg border border-border transition-colors hover:border-destructive/50 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </li>
          ))}
          {items.length === 0 && (
            <li className="rounded-xl border border-border p-4 text-center text-sm text-muted-foreground">
              No announcements yet.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
