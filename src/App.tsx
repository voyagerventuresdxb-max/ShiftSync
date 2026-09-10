import { RouterProvider } from 'react-router-dom';
import { AppStateProvider } from './state/AppStateContext';
import { IdentityProvider } from './state/IdentityContext';
import { ConnectivityProvider } from './state/ConnectivityContext';
import { FloorFeedbackQueueProvider } from './state/FloorFeedbackQueueContext';
import { router } from './router';

export default function App() {
  return (
    <ConnectivityProvider>
      <IdentityProvider>
        <FloorFeedbackQueueProvider>
          <AppStateProvider>
            <RouterProvider router={router} />
          </AppStateProvider>
        </FloorFeedbackQueueProvider>
      </IdentityProvider>
    </ConnectivityProvider>
  );
}
