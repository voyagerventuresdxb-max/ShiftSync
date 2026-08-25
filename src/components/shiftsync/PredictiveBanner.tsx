import { TrendingUp } from 'lucide-react';

export function PredictiveBanner() {
  return (
    <section className="panel-raised animate-rise relative overflow-hidden p-4 sm:p-5">
      <div className="gold-rule absolute inset-x-0 top-0 h-px opacity-60" />
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10">
          <TrendingUp className="h-4 w-4 text-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">POS forecast</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            No POS or reservation system connected yet. Once one is linked, cover-volume alerts
            and one-click staffing adjustments will appear here.
          </p>
        </div>
      </div>
    </section>
  );
}
