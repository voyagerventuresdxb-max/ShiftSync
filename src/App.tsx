import { RouterProvider } from 'react-router-dom';
import { AppStateProvider } from './state/AppStateContext';
import { IdentityProvider } from './state/IdentityContext';
import { ConnectivityProvider } from './state/ConnectivityContext';
import { router } from './router';

export default function App() {
  return (
    <ConnectivityProvider>
      <IdentityProvider>
        <AppStateProvider>
          <RouterProvider router={router} />
        </AppStateProvider>
      </IdentityProvider>
    </ConnectivityProvider>
  );
}
