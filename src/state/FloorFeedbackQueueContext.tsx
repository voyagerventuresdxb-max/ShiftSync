import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { submitFloorFeedback } from '../api/floorFeedback';
import { useConnectivity } from './ConnectivityContext';
import { useIdentity } from './IdentityContext';

/**
 * SafetyValve is the one write path in the offline-support pass that gets
 * queued-for-automatic-retry rather than blocked outright — there's no
 * coordination risk (feedback landing now vs. in 10 minutes doesn't create a
 * conflicting real-world state, unlike a shift decision or a clock-in).
 * Persisted so the queue survives a reload while still offline.
 */
const STORAGE_KEY = 'shiftsync.floorFeedbackQueue';

export interface QueuedFeedback {
  id: string;
  content: string;
}

function loadQueue(): QueuedFeedback[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedFeedback[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: QueuedFeedback[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full/unavailable — the queue just won't survive a reload; not worth surfacing to the user.
  }
}

interface FloorFeedbackQueueValue {
  queue: QueuedFeedback[];
  enqueue: (content: string) => void;
}

const Ctx = createContext<FloorFeedbackQueueValue | null>(null);

export function FloorFeedbackQueueProvider({ children }: { children: ReactNode }) {
  const { online } = useConnectivity();
  const { session } = useIdentity();
  const [queue, setQueue] = useState<QueuedFeedback[]>(() => loadQueue());
  const flushingRef = useRef(false);

  const enqueue = useCallback((content: string) => {
    setQueue((prev) => {
      const next = [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, content }];
      saveQueue(next);
      return next;
    });
  }, []);

  // Re-reads the queue from storage at every step (not the `queue` state
  // closure) so a submission enqueued mid-flush is picked up on the next
  // iteration rather than racing a stale snapshot. Stops at the first
  // failure and leaves the rest queued for the next reconnect, rather than
  // hammering a connection that's still actually flaky.
  const flush = useCallback(async () => {
    if (flushingRef.current || !session) return;
    flushingRef.current = true;
    try {
      for (;;) {
        const current = loadQueue();
        if (current.length === 0) break;
        const [head, ...rest] = current;
        try {
          await submitFloorFeedback(session.token, head!.content);
          saveQueue(rest);
          setQueue(rest);
        } catch {
          break;
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, [session]);

  useEffect(() => {
    if (online) void flush();
  }, [online, flush]);

  const value = useMemo(() => ({ queue, enqueue }), [queue, enqueue]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFloorFeedbackQueue(): FloorFeedbackQueueValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFloorFeedbackQueue must be used within FloorFeedbackQueueProvider');
  return ctx;
}
