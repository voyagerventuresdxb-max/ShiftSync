import { createContext, useContext, useState, type ReactNode } from 'react';
import { loadSession, saveSession, clearSession, revokeSession, type StoredSession } from '../api/identity';

interface IdentityValue {
  session: StoredSession | null;
  login: (session: StoredSession) => void;
  logout: () => void;
}

const IdentityCtx = createContext<IdentityValue | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());

  const login = (next: StoredSession) => {
    saveSession(next);
    setSession(next);
  };
  /**
   * Ends the session server-side as well as locally. The revoke call is
   * best-effort and deliberately not awaited: if the network is down we still
   * clear local state immediately rather than trapping the user in a session
   * they asked to leave. The token they're discarding is the only thing that
   * could have used it anyway.
   */
  const logout = () => {
    const current = session;
    clearSession();
    setSession(null);
    if (current) {
      void revokeSession(current.token).catch(() => {
        // Already signed out locally; a failed revoke is not worth surfacing.
      });
    }
  };

  return <IdentityCtx.Provider value={{ session, login, logout }}>{children}</IdentityCtx.Provider>;
}

export function useIdentity(): IdentityValue {
  const ctx = useContext(IdentityCtx);
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider');
  return ctx;
}
