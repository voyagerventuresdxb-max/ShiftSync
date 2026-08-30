import { createBrowserRouter, Link, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Pencil, Rocket } from 'lucide-react';
import { AppShell, type RouteHandle } from './components/shiftsync/AppShell';
import { useIdentity } from './state/IdentityContext';
import HomeContent from './routes/HomeRoute';
import SchedulingContent from './routes/SchedulingRoute';
import ScheduleEditorContent from './routes/ScheduleEditorRoute';
import FloorPlanContent from './routes/FloorPlanRoute';
import PeopleContent from './routes/PeopleRoute';
import ProfileContent from './routes/ProfileRoute';
import JoinContent from './routes/JoinRoute';
import MyShiftsContent from './routes/MyShiftsRoute';
import OnboardingContent from './routes/OnboardingRoute';

/**
 * Gates the manager-dashboard pages (Scheduling/Approvals, Floor Plan,
 * People/Staff-Directory/Pending-Approvals, Onboarding) behind a real session
 * instead of letting them render and silently show nothing or dead-end on an
 * unactionable error — those pages' own backend routes have required a
 * session since the actor-identity-enforcement phase, so an unauthenticated
 * visit could previously only ever fail. Sends straight to `/join`'s existing
 * login mode rather than its default join/self-registration mode. Does not
 * redirect back to the originally-requested page after login — `JoinFlow`'s
 * login success path always lands on `/my-shifts` today; wiring a
 * return-to-origin redirect through that flow was not part of this fix (see
 * MEMORY.md's open follow-up).
 *
 * `/onboarding` was originally left off this list on the reasoning that it
 * "doesn't touch the four hardened routes" — wrong: its venue-setup step
 * calls `/api/locations/:id`, which WAS hardened in the same phase that
 * reasoning was written for. Caught by that phase's own mandatory
 * final-review pattern, applied here retroactively. `/schedule` (the Shift
 * Editor) is still correctly excluded — it only touches `shifts.ts`, which
 * remains unauthenticated.
 */
function RequireSession({ children }: { children: ReactNode }) {
  const { session } = useIdentity();
  if (!session) return <Navigate to="/join?mode=login" replace />;
  return <>{children}</>;
}

/** Header text per route, read by AppShell via useMatches(). */
const handles = {
  home: { title: 'ShiftSync' },
  floorPlan: { title: 'Floor plan' },
  profile: { title: 'Profile' },
  scheduleEditor: { title: 'Shift Editor' },
  join: { title: 'Join' },
  myShifts: { title: 'My Shifts' },
  onboarding: { title: 'Onboarding' },
} satisfies Record<string, RouteHandle>;

/**
 * AppShell is a pathless layout route wrapping every page, so exactly one
 * AppShell (and therefore one RadialDock) exists in the tree and survives
 * navigation between children — the dial's spring animation, the voice
 * toggle and the notification state all persist across route changes.
 */
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomeContent />, handle: handles.home },
      {
        path: '/scheduling',
        element: (
          <RequireSession>
            <SchedulingContent />
          </RequireSession>
        ),
        handle: {
          title: 'Scheduling',
          action: (
            <Link to="/schedule" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground">
              <Pencil className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Shift editor</span>
            </Link>
          ),
        },
      },
      { path: '/schedule', element: <ScheduleEditorContent />, handle: handles.scheduleEditor },
      {
        path: '/floor-plan',
        element: (
          <RequireSession>
            <FloorPlanContent />
          </RequireSession>
        ),
        handle: handles.floorPlan,
      },
      {
        path: '/people',
        element: (
          <RequireSession>
            <PeopleContent />
          </RequireSession>
        ),
        // Onboarding is a venue-setup action a manager reaches from People —
        // the same header-action pattern /scheduling uses for the Shift editor.
        // Without it the wizard was reachable only by typing the URL.
        handle: {
          title: 'People',
          action: (
            <Link to="/onboarding" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground">
              <Rocket className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Onboarding</span>
            </Link>
          ),
        },
      },
      { path: '/profile', element: <ProfileContent />, handle: handles.profile },
      { path: '/join', element: <JoinContent />, handle: handles.join },
      { path: '/my-shifts', element: <MyShiftsContent />, handle: handles.myShifts },
      {
        path: '/onboarding',
        element: (
          <RequireSession>
            <OnboardingContent />
          </RequireSession>
        ),
        handle: handles.onboarding,
      },
    ],
  },
]);
