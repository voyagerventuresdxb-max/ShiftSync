import { AppShell } from '../components/shiftsync/AppShell';
import FloorPlanTab from '../components/FloorPlan/FloorPlanTab';

export default function FloorPlanRoute() {
  return (
    <AppShell title="Floor plan">
      <FloorPlanTab locationId="seed-location" />
    </AppShell>
  );
}
