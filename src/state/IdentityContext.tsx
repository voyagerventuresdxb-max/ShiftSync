import { createContext, useContext, useState, type ReactNode } from 'react';
import { loadSession, saveSession, clearSession, type StoredSession } from '../api/identity';

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
  const logout = () => {
    clearSession();
    setSession(null);
  };

  return <IdentityCtx.Provider value={{ session, login, logout }}>{children}</IdentityCtx.Provider>;
}

export function useIdentity(): IdentityValue {
  const ctx = useContext(IdentityCtx);
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider');
  return ctx;
}
