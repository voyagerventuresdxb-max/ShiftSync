import { AppShell } from '../components/shiftsync/AppShell';
import Dashboard from '../components/Dashboard';
import { useAppState } from '../state/AppStateContext';

export default function HomeRoute() {
  const { mergedRoster, config, swapRequests, handleRequestCover, handleDecideRequest } = useAppState();
  return (
    <AppShell title="ShiftSync">
      <Dashboard
        roster={mergedRoster}
        config={config}
        swapRequests={swapRequests}
        onRequestCover={handleRequestCover}
        onDecideRequest={handleDecideRequest}
      />
    </AppShell>
  );
}
