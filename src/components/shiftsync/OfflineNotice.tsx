import { WifiOff } from 'lucide-react';

/** Subtle notice for a surface that already has data loaded, while offline — the data stays on screen (Phase 2 of the offline-support pass), this just flags that it might not reflect the latest server state. */
export function StaleDataNotice() {
  return (
    <p className="flex items-center gap-1.5 px-4 pb-2 text-[11px] text-muted-foreground sm:px-5">
      <WifiOff className="h-3 w-3 shrink-0" /> Offline — this may be out of date.
    </p>
  );
}

/**
 * Distinct from a genuine "no data" empty state — this is for a cold load
 * (nothing was ever successfully fetched) that failed specifically because
 * there's no connection, not because the list is actually empty.
 */
export function OfflineEmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <WifiOff className="h-5 w-5 text-muted-foreground" />
      {message}
    </div>
  );
}
