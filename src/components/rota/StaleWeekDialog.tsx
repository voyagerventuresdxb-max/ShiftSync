import { cn } from '@/lib/utils';
import type { WeekDocDto } from '../../../shared/rotaWeek';
import { diffWeeks, shortDay } from '@/engine/rotaGrid';
import { Dialog, btn } from './Dialog';

/**
 * Stale week (Design board B8): a save met a newer version of this week —
 * someone else (another manager, voice, an import) changed it first. The
 * change on screen was NOT applied. Per-row merge is out of scope: the
 * dialog shows what the server now holds and the one way forward is to
 * reload that week and redo the change on top of it.
 */
export function StaleWeekDialog(props: { mine: WeekDocDto; theirs: WeekDocDto; onReload: () => void }) {
  const { mine, theirs, onReload } = props;
  const rows = diffWeeks(mine, theirs);
  const who = (id: string | null) => (id ? (theirs.people.find((p) => p.id === id) ?? mine.people.find((p) => p.id === id))?.fullName.split(/\s+/)[0] ?? 'Someone' : 'Open shifts');
  return (
    <Dialog title="Someone else changed this week" eyebrow="Review before you continue" onClose={onReload} width="md" dismissable={false} hideClose>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Your last change was <b className="text-foreground">not applied</b>: the week moved on to a newer version
          {theirs.version > mine.version ? ` (${theirs.version - mine.version} save${theirs.version - mine.version === 1 ? '' : 's'} ahead)` : ''}. Reload it, then make your change again.
        </p>
        {rows.length > 0 ? (
          <ul aria-label="What the newer week holds" className="space-y-1.5">
            {rows.slice(0, 8).map((r) => (
              <li key={`${r.date}|${r.userId}`} className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm">
                <b className="font-semibold">
                  {who(r.userId)} · {shortDay(r.date)}
                </b>{' '}
                <span className="text-muted-foreground">
                  {r.mine} → {r.theirs}
                </span>
              </li>
            ))}
            {rows.length > 8 && <li className="px-1 text-xs text-muted-foreground">and {rows.length - 8} more</li>}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">The cells look the same; only the version moved (a publish or a status change).</p>
        )}
        <button type="button" data-autofocus onClick={onReload} className={cn(btn.base, btn.gold, 'w-full')}>
          Reload week
        </button>
      </div>
    </Dialog>
  );
}
