import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Reuses the existing, unauthenticated health-check route (server/src/app.ts)
 * rather than adding a new endpoint just for this — it's already the
 * cheapest real round trip to the backend.
 */
const REACHABILITY_URL = '/api/health';
const REACHABILITY_INTERVAL_MS = 15_000;
const REACHABILITY_TIMEOUT_MS = 5_000;

/**
 * `navigator.onLine === false` is trustworthy (the OS/browser is reporting no
 * network interface at all — there is nothing to reach). `navigator.onLine
 * === true` is NOT (it's true the moment a router is associated, even with
 * no real upstream internet) — so a real request is what actually confirms
 * reachability, not just this flag.
 */
async function checkReachable(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
  try {
    const res = await fetch(REACHABILITY_URL, { method: 'GET', cache: 'no-store', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

interface ConnectivityValue {
  /** Best-effort "is the backend actually reachable right now" — not just navigator.onLine. */
  online: boolean;
}

const ConnectivityCtx = createContext<ConnectivityValue | null>(null);

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    let cancelled = false;
    const runCheck = async () => {
      const reachable = await checkReachable();
      if (!cancelled) setOnline(reachable);
    };

    // The browser's own 'offline' event is applied immediately — it's a
    // reliable "the interface just went down" signal. Its 'online'
    // counterpart is NOT applied at face value (see checkReachable's
    // comment); it just triggers a real check instead of assuming.
    const handleOffline = () => {
      if (!cancelled) setOnline(false);
    };
    const handleOnline = () => {
      void runCheck();
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    void runCheck();
    const interval = setInterval(() => void runCheck(), REACHABILITY_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      clearInterval(interval);
    };
  }, []);

  const value = useMemo(() => ({ online }), [online]);
  return <ConnectivityCtx.Provider value={value}>{children}</ConnectivityCtx.Provider>;
}

export function useConnectivity(): ConnectivityValue {
  const ctx = useContext(ConnectivityCtx);
  if (!ctx) throw new Error('useConnectivity must be used within ConnectivityProvider');
  return ctx;
}
