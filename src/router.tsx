import { createBrowserRouter, Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { AppShell, type RouteHandle } from './components/shiftsync/AppShell';
import HomeContent from './routes/HomeRoute';
import SchedulingContent from './routes/SchedulingRoute';
import ScheduleEditorContent from './routes/ScheduleEditorRoute';
import FloorPlanContent from './routes/FloorPlanRoute';
import PeopleContent from './routes/PeopleRoute';
import ProfileContent from './routes/ProfileRoute';
import JoinContent from './routes/JoinRoute';

/** Header text per route, read by AppShell via useMatches(). */
const handles = {
  home: { title: 'ShiftSync' },
  floorPlan: { title: 'Floor plan' },
  people: { title: 'People' },
  profile: { title: 'Profile' },
  scheduleEditor: { title: 'Shift Editor' },
  join: { title: 'Join' },
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
        element: <SchedulingContent />,
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
      { path: '/floor-plan', element: <FloorPlanContent />, handle: handles.floorPlan },
      { path: '/people', element: <PeopleContent />, handle: handles.people },
      { path: '/profile', element: <ProfileContent />, handle: handles.profile },
      { path: '/join', element: <JoinContent />, handle: handles.join },
    ],
  },
]);
