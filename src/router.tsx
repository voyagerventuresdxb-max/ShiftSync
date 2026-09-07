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
 * MANAGER/OWNER-only server-side since the actor-identity phase),
 * `/onboarding` (entirely a manager action), and, as of 2026-09-05,
 * `/schedule` (see below) have no legitimate STAFF use at all, unlike
 * `/scheduling`/`/floor-plan`, which genuinely do mix staff-readable/
 * staff-usable content with manager-only sub-actions that fail
 * informatively per-action rather than page-wide. Redirects to
 * `/my-shifts`, the same landing spot `JoinFlow`'s login success path
 * already uses for a STAFF session.
 *
 * **`/schedule` moved from the "mixed" group above into the `managerOnly`
 * one on 2026-09-05 — this comment previously claimed the opposite, and
 * the false claim itself was a real risk (see MEMORY.md).** `shifts.ts`'s
 * mutation routes (`POST /`, `PATCH /:id`, `DELETE /:id`, `POST /bulk`,
 * `POST /:locationId/publish`) were `requireSession`-only, with no
 * `requireManager` check at all and no client-side gate in the Shift Editor
 * either — so a STAFF session's manager-only sub-actions on `/schedule`
 * silently SUCCEEDED instead of failing per-action, letting any employee
 * edit or delete any coworker's shift. That gap is now closed
 * (`shifts.ts` is `requireManager`-gated), which also means `/schedule` has
 * no remaining staff-usable content at all — unlike `/scheduling`, it was
 * never a place STAFF could read anything either, only a write surface —
 * so once the routes were actually protected, leaving the PAGE reachable
 * only bought a STAFF session a page-wide 403 wall instead of a clean
 * redirect. `managerOnly` added here to close that too, matching `/people`/
 * `/onboarding`'s existing pattern exactly — kept as a safety net for a
 * stale bookmark or direct URL entry. **Decided (2026-09-05): the link
 * itself must not render for STAFF either** — `/scheduling`'s "Shift
 * editor" action is `<ShiftEditorLink />` (below), which returns `null` for
 * a STAFF session instead of a link that then silently teleports them away
 * on click with no explanation. `managerOnly` here is the backstop for the
 * URL-typed case that component can't cover, not the primary UX.
 */
function RequireSession({ children, managerOnly }: { children: ReactNode; managerOnly?: boolean }) {
  const { session } = useIdentity();
  const location = useLocation();
  if (!session) {
    // Includes the hash too, even though no gated route reads one today —
    // cheap to keep, and it means a future hash-based deep link (e.g.
    // `/floor-plan#table-12`) doesn't silently lose its fragment across a
    // sign-in round trip the day one gets added.
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);
    return <Navigate to={`/join?mode=login&returnTo=${returnTo}`} replace />;
  }
  // Positive check (redirect unless confirmed MANAGER/OWNER), not a negative
  // one (redirect only if STAFF) — matching `ShiftEditorLink`'s fix below
  // for the same reason: `loadSession()` (`api/identity.ts`) parses
  // `localStorage` at runtime with no validation that `systemRole` is
  // actually one of the three expected values, so a corrupted/tampered
  // session blob could carry an unexpected role string. A negative check
  // would let that fall through unredirected onto a managerOnly page; this
  // fails closed instead.
  if (managerOnly && session.user.systemRole !== 'MANAGER' && session.user.systemRole !== 'OWNER') {
    return <Navigate to="/my-shifts" replace />;
  }
  return <>{children}</>;
}

/**
 * `/scheduling`'s header action — only rendered for a MANAGER/OWNER
 * session. `/schedule` itself is `managerOnly`-gated (see `RequireSession`
 * above) purely as a safety net for a stale bookmark or direct URL entry;
 * the link that actually advertises it must not render for STAFF at all,
 * not just redirect after the click — otherwise a STAFF session sees a
 * normal-looking nav link that silently teleports them away the moment
 * they click it, with no explanation. Hiding it here is the fix; the
 * `managerOnly` redirect stays as the backstop for the URL-typed case this
 * component can't cover.
 *
 * Positive check (render only for a confirmed MANAGER/OWNER), not a
 * negative one (hide only for STAFF) — a caught-before-shipping bug in an
 * earlier draft used `session?.user.systemRole === 'STAFF'`, which is
 * `undefined === 'STAFF'` (`false`) when there's no session at all, so the
 * link would render for a genuinely signed-out visitor too. `AppShell`
 * reads this `handle.action` via `useMatches()` independent of
 * `RequireSession`'s own redirect (they're sibling renders in the same
 * commit, and `<Navigate>` fires its actual navigation in an effect, one
 * tick after that first render) — so a negative check would have let a
 * signed-out visitor's very first paint include a manager-only link before
 * the redirect to `/join` took over.
 */
function ShiftEditorLink() {
  const { session } = useIdentity();
  if (session?.user.systemRole !== 'MANAGER' && session?.user.systemRole !== 'OWNER') return null;
  return (
    <Link to="/schedule" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground">
      <Pencil className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Shift editor</span>
    </Link>
  );
}

/**
 * `/people`'s header action — same manager-only-render pattern as
 * `ShiftEditorLink` above, and newly necessary here now that `/people`
 * itself is no longer `managerOnly`-gated at the router level: without this
 * component's own check, a STAFF session would see a normal-looking
 * "Onboarding" link that 403s the moment they click it (onboarding is
 * entirely a manager/venue-setup action), the exact silently-teleports-you
 * anti-pattern this codebase keeps fixing elsewhere.
 */
function OnboardingLink() {
  const { session } = useIdentity();
  if (session?.user.systemRole !== 'MANAGER' && session?.user.systemRole !== 'OWNER') return null;
  return (
    <Link to="/onboarding" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground">
      <Rocket className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Onboarding</span>
    </Link>
  );
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
          action: <ShiftEditorLink />,
        },
      },
      {
        path: '/schedule',
        element: (
          <RequireSession managerOnly>
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
        // No longer managerOnly (2026-09-07): People is one of the app's 4
        // primary always-visible nav tabs (RadialDock), not a manager-only
        // page tucked behind a hidden link — a STAFF session must be able to
        // open it at all. The manager-only sub-sections within it
        // (PendingApprovals, FloorFeedbackReview, StaffDirectory's write
        // actions) are gated individually inside PeopleRoute.tsx instead,
        // the same per-component pattern already used by /scheduling and
        // /floor-plan for their own manager-only sub-actions — see
        // OnboardingLink below for why the header action still needs its
        // own explicit role check independent of this page-level gate.
        element: (
          <RequireSession>
            <PeopleContent />
          </RequireSession>
        ),
        handle: {
          title: 'People',
          action: <OnboardingLink />,
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
