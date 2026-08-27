import { useState, type ReactNode } from 'react';
import { Bell, CalendarCheck } from 'lucide-react';
import { Link, Outlet, useMatches, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { RadialDock } from '@/components/shiftsync/RadialDock';
import { useAppState } from '@/state/AppStateContext';

/**
 * Per-route header data, attached to each child route as its `handle`.
 * AppShell is a layout route rendered exactly once for the whole app, so it
 * can't take these as props — it reads them off the active route match.
 */
export interface RouteHandle {
  /** Page title shown in the shell header. */
  title: string;
  /** Optional override for the header's secondary line (defaults to the venue name). */
  eyebrow?: string;
  /** Optional header-right control for this route. */
  action?: ReactNode;
}

function isRouteHandle(handle: unknown): handle is RouteHandle {
  return typeof handle === 'object' && handle !== null && typeof (handle as RouteHandle).title === 'string';
}

/** First letter of the venue name, for the profile avatar. */
function avatarInitial(venueName: string): string {
  return venueName.trim().charAt(0).toUpperCase() || '·';
}

export function AppShell() {
  // Deepest matched route wins, so a nested route can override its parent's header.
  const matches = useMatches();
  const handle = matches
    .map((match) => match.handle)
    .filter(isRouteHandle)
    .at(-1);

  const { config } = useAppState();
  const title = handle?.title ?? config.name;
  const eyebrow = handle?.eyebrow ?? config.name;
  const action = handle?.action;

  const [voiceOn, setVoiceOn] = useState(false);
  const [unread, setUnread] = useState(true);

  // My Shifts is the staff-facing home screen, so it needs a real destination
  // in the shell chrome exactly like /profile has — the four-tab RadialDock is
  // the manager-side nav and has no room for it.
  const onMyShifts = useLocation().pathname === '/my-shifts';

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-20 px-3 pt-3 sm:px-4">
        <div className="glass-bar mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl px-3 py-2.5 shadow-lux sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to="/profile"
              aria-label="Open your profile"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-sm font-bold text-accent transition-transform duration-200 hover:scale-105 active:scale-95"
            >
              {avatarInitial(config.name)}
            </Link>

            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight">{title}</p>
              <p className="truncate text-[11px] text-muted-foreground">{eyebrow}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {action}
            <Link
              to="/my-shifts"
              aria-label="Open My Shifts"
              aria-current={onMyShifts ? 'page' : undefined}
              className={cn(
                'grid h-9 w-9 place-items-center rounded-full border transition-all duration-300',
                onMyShifts
                  ? 'glow-gold border-accent/50 bg-accent/15 text-accent'
                  : 'border-border text-foreground/40 hover:text-foreground/70',
              )}
            >
              <CalendarCheck className="h-4 w-4" strokeWidth={onMyShifts ? 2.4 : 1.6} />
            </Link>
            <button
              onClick={() => setUnread((u) => !u)}
              aria-label={unread ? 'Unread notifications' : 'Notifications'}
              className={cn(
                'relative grid h-9 w-9 place-items-center rounded-full border transition-all duration-300',
                unread
                  ? 'glow-gold border-accent/50 bg-accent/15 text-accent'
                  : 'border-border text-foreground/40 hover:text-foreground/70',
              )}
              style={{ transitionTimingFunction: 'cubic-bezier(0.34,1.56,0.64,1)' }}
            >
              <Bell
                className="h-4 w-4"
                strokeWidth={unread ? 2.4 : 1.6}
                fill={unread ? 'currentColor' : 'none'}
                fillOpacity={unread ? 0.22 : 0}
              />
              {unread && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent shadow-glow" />
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        <Outlet />
      </main>

      <RadialDock listening={voiceOn} onToggleListening={() => setVoiceOn((v) => !v)} />
    </div>
  );
}
