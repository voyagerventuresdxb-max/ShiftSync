import { RouterProvider } from 'react-router-dom';
import { AppStateProvider } from './state/AppStateContext';
import { IdentityProvider } from './state/IdentityContext';
import { router } from './router';

export default function App() {
  return (
    <IdentityProvider>
      <AppStateProvider>
        <RouterProvider router={router} />
      </AppStateProvider>
    </IdentityProvider>
  );
}
