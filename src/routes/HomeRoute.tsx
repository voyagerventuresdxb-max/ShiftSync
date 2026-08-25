import Dashboard from '../components/Dashboard';
import { useAppState } from '../state/AppStateContext';

export default function HomeContent() {
  const { mergedRoster, config, swapRequests, handleRequestCover, handleDecideRequest } = useAppState();
  return (
    <Dashboard
      roster={mergedRoster}
      config={config}
      swapRequests={swapRequests}
      onRequestCover={handleRequestCover}
      onDecideRequest={handleDecideRequest}
    />
  );
}
