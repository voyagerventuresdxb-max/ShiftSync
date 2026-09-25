import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIdentity } from '@/state/IdentityContext';
import { fetchNotifications, markNotificationRead, markAllNotificationsRead, type AppNotification } from '@/api/notifications';
import { requestScheduleRefresh } from '@/lib/scheduleRefresh';

/** How often to re-poll while the panel is closed — there's no push-to-client channel for "a new notification landed", so this is a plain interval, same pattern as ConnectivityContext's reachability check. */
const POLL_MS = 30_000;

function formatWhen(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Replaces AppShell's old decorative bell (a local `unread` boolean toggled
 * by clicking it, wired to nothing real) with one backed by the actual
 * notification history that server/src/lib/push.ts's notifyUser writes.
 */
export function NotificationBell() {
  const { session } = useIdentity();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const list = await fetchNotifications(session.token);
      setNotifications(list);
      setError(null);
    } catch {
      // A failed background poll shouldn't nag the user; the panel shows a
      // retry message only if they open it and it's actually empty/stale.
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, [session, refresh]);

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  const handleToggle = useCallback(() => {
    if (!session) return;
    setOpen((prev) => {
      if (!prev) void refresh();
      return !prev;
    });
  }, [session, refresh]);

  const handleItemClick = useCallback(
    async (n: AppNotification) => {
      if (!session) return;
      setOpen(false);
      if (!n.readAt) {
        setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
        try {
          await markNotificationRead(session.token, n.id);
        } catch {
          // Best-effort: the item still opens either way; a failed mark-read
          // just means it may show as unread again on the next poll.
        }
      }
      // Refetch schedule views even when the target route is already mounted
      // (AppState lives above the router, so navigating alone won't refetch).
      requestScheduleRefresh();
      if (n.url) navigate(n.url);
    },
    [session, navigate],
  );

  const handleMarkAllRead = useCallback(async () => {
    if (!session) return;
    const now = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    try {
      await markAllNotificationsRead(session.token);
    } catch {
      setError('Could not mark all as read.');
    }
  }, [session]);

  return (
    <div className="relative">
      <button
        onClick={handleToggle}
        aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
        className={cn(
          'relative grid h-9 w-9 place-items-center rounded-full border transition-all duration-300',
          unreadCount > 0
            ? 'glow-gold border-accent/50 bg-accent/15 text-accent'
            : 'border-border text-foreground/40 hover:text-foreground/70',
        )}
        style={{ transitionTimingFunction: 'cubic-bezier(0.34,1.56,0.64,1)' }}
      >
        <Bell
          className="h-4 w-4"
          strokeWidth={unreadCount > 0 ? 2.4 : 1.6}
          fill={unreadCount > 0 ? 'currentColor' : 'none'}
          fillOpacity={unreadCount > 0 ? 0.22 : 0}
        />
        {unreadCount > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent shadow-glow" />}
      </button>

      {open && (
        <div className="fixed inset-0 z-50" onClick={() => setOpen(false)}>
          <div
            className="panel absolute right-3 top-16 w-[min(22rem,calc(100vw-1.5rem))] shadow-lux sm:right-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 pb-2">
              <p className="eyebrow">Notifications</p>
              {unreadCount > 0 && (
                <button className="text-xs font-medium text-accent hover:underline" onClick={() => void handleMarkAllRead()}>
                  Mark all read
                </button>
              )}
            </div>

            {error && (
              <div className="error-block mx-4 mb-2" role="alert">
                <p>{error}</p>
              </div>
            )}

            {notifications.length === 0 ? (
              <p className="hint p-4 pt-1">Nothing yet — you'll see things here like new section assignments.</p>
            ) : (
              <ul className="max-h-96 overflow-y-auto">
                {notifications.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => void handleItemClick(n)}
                      className={cn(
                        'flex w-full flex-col gap-0.5 border-t border-border/60 px-4 py-3 text-left transition-colors hover:bg-accent/5',
                        !n.readAt && 'bg-accent/5',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {!n.readAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                        <span className="text-sm font-medium">{n.title}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{n.body}</span>
                      <span className="text-[11px] text-foreground/40">{formatWhen(n.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
