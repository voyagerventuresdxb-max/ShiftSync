import { createBrowserRouter, Link, Navigate, useLocation } from 'react-router-dom';
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
import SignupContent from './routes/SignupRoute';
import MyShiftsContent from './routes/MyShiftsRoute';
import OnboardingContent from './routes/OnboardingRoute';

/**
 * Gates the manager-dashboard pages (Scheduling/Approvals, Floor Plan,
 * People/Staff-Directory/Pending-Approvals, Onboarding, Shift Editor) behind
 * a real session instead of letting them render and silently show nothing or
 * dead-end on an unactionable error — those pages' own backend routes have
 * required a session since the actor-identity-enforcement phase, so an
 * unauthenticated visit could previously only ever fail. Sends straight to
 * `/join`'s existing login mode rather than its default join/self-
 * registration mode.
 *
 * When redirecting a signed-out visit, the current path (pathname + search)
 * travels along as a `returnTo` query param so `JoinFlow`'s login success
 * path can send the visitor back to where they were headed instead of
 * always landing on `/my-shifts` (see MEMORY.md's open follow-up, now
 * closed). `managerOnly`'s redirect below is unrelated and deliberately
 * left untouched — it sends a real, valid STAFF session away from a page
 * it never had access to, not an unauthenticated visitor.
 *
 * `/onboarding` was originally left off this list on the reasoning that it
 * "doesn't touch the four hardened routes" — wrong: its venue-setup step
 * calls `/api/locations/:id`, which WAS hardened in the same phase that
 * reasoning was written for. Caught by that phase's own mandatory
 * final-review pattern, applied here retroactively.
 *
 * `/schedule` (the Shift Editor) was originally left off this list on
 * purpose, to serve a "walk up to the shared venue device, no personal
 * login" kiosk use case — see MEMORY.md's multi-tenant-signup-phase entry
 * for the full "kiosk-access fork" this created and the decision that
 * resolved it (2026-08-31): `/` (Home) stays anonymous-friendly via an
 * explicit venue-binding mechanism (`api/venueBinding.ts`) because it is a
 * low-stakes glance board, but `/schedule` is a write surface, and
 * unattributed shift mutation would undermine the audit trail this product
 * is meant to guarantee — so it now requires the same session every other
 * write-capable page already does. `shifts.ts`'s own routes were hardened
 * to match in the same phase (previously the only one of this app's
 * mutation route files with no session check at all).
 *
 * `managerOnly` additionally redirects a real, valid STAFF session away
 * instead of letting the page render and immediately 403 on every API call
 * it makes — `/people` (Staff Directory + Pending Approvals, both
 * MANAGER/OWNER-only server-side since the actor-identity phase) and
 * `/onboarding` (entirely a manager action) have no legitimate STAFF use at
 * all, unlike `/scheduling`/`/floor-plan`/`/schedule`, which mix
 * staff-readable/staff-usable content with manager-only sub-actions that
 * already fail informatively per-action rather than page-wide. Redirects to
 * `/my-shifts`, the same landing spot `JoinFlow`'s login success path
 * already uses for a STAFF session.
 */
function RequireSession({ children, managerOnly }: { children: ReactNode; managerOnly?: boolean }) {
  const { session } = useIdentity();
  const location = useLocation();
  if (!session) {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/join?mode=login&returnTo=${returnTo}`} replace />;
  }
  if (managerOnly && session.user.systemRole === 'STAFF') return <Navigate to="/my-shifts" replace />;
  return <>{children}</>;
}

/** Header text per route, read by AppShell via useMatches(). */
const handles = {
  home: { title: 'ShiftSync' },
  floorPlan: { title: 'Floor plan' },
  profile: { title: 'Profile' },
  scheduleEditor: { title: 'Shift Editor' },
  join: { title: 'Join' },
  signup: { title: 'Sign up' },
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
      {
        path: '/schedule',
        element: (
          <RequireSession>
            <ScheduleEditorContent />
          </RequireSession>
        ),
        handle: handles.scheduleEditor,
      },
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
          <RequireSession managerOnly>
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
      // Not behind RequireSession — this is how someone gets their FIRST
      // session (a brand-new venue). Gating it would make it unreachable.
      { path: '/signup', element: <SignupContent />, handle: handles.signup },
      { path: '/my-shifts', element: <MyShiftsContent />, handle: handles.myShifts },
      {
        path: '/onboarding',
        element: (
          <RequireSession managerOnly>
            <OnboardingContent />
          </RequireSession>
        ),
        handle: handles.onboarding,
      },
    ],
  },
]);
