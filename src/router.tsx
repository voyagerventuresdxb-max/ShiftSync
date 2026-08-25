import { createBrowserRouter } from 'react-router-dom';
import HomeRoute from './routes/HomeRoute';
import SchedulingRoute from './routes/SchedulingRoute';
import FloorPlanRoute from './routes/FloorPlanRoute';
import PeopleRoute from './routes/PeopleRoute';
import ProfileRoute from './routes/ProfileRoute';

export const router = createBrowserRouter([
  { path: '/', element: <HomeRoute /> },
  { path: '/scheduling', element: <SchedulingRoute /> },
  { path: '/floor-plan', element: <FloorPlanRoute /> },
  { path: '/people', element: <PeopleRoute /> },
  { path: '/profile', element: <ProfileRoute /> },
]);
