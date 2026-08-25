import { createBrowserRouter } from 'react-router-dom';
import { AppShell, type RouteHandle } from './components/shiftsync/AppShell';
import HomeContent from './routes/HomeRoute';
import SchedulingContent from './routes/SchedulingRoute';
import FloorPlanContent from './routes/FloorPlanRoute';
import PeopleContent from './routes/PeopleRoute';
import ProfileContent from './routes/ProfileRoute';

/** Header text per route, read by AppShell via useMatches(). */
const handles = {
  home: { title: 'ShiftSync' },
  scheduling: { title: 'Scheduling' },
  floorPlan: { title: 'Floor plan' },
  people: { title: 'People' },
  profile: { title: 'Profile' },
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
      { path: '/scheduling', element: <SchedulingContent />, handle: handles.scheduling },
      { path: '/floor-plan', element: <FloorPlanContent />, handle: handles.floorPlan },
      { path: '/people', element: <PeopleContent />, handle: handles.people },
      { path: '/profile', element: <ProfileContent />, handle: handles.profile },
    ],
  },
]);
