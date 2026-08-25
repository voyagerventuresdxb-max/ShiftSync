import { RouterProvider } from 'react-router-dom';
import { AppStateProvider } from './state/AppStateContext';
import { router } from './router';

export default function App() {
  return (
    <AppStateProvider>
      <RouterProvider router={router} />
    </AppStateProvider>
  );
}
