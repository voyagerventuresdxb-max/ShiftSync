/** Placeholder while a lazily-loaded screen or panel downloads — same pulse blocks as the list skeletons (PersonalRota, ApprovalsPanel). */
export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <section className="panel animate-rise space-y-3 p-5" aria-busy="true" aria-label="Loading">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
      ))}
    </section>
  );
}
