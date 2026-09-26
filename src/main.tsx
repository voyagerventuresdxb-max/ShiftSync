import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerServiceWorker } from './lib/push';
import { installKeyboardInsetScroll } from './lib/keyboardInset';
import './styles/global.css';
import './styles/tailwind.css';

// Safe to call unconditionally on every load — registering a service
// worker never prompts the user for anything. The actual push-permission
// prompt only ever fires from an explicit opt-in action (see
// src/lib/push.ts's subscribeToPush), never automatically here.
void registerServiceWorker();

// iOS Safari: keep the focused field above the keyboard (see the module).
installKeyboardInsetScroll();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
