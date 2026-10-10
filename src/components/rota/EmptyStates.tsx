import { useState } from 'react';
import { Clock3, Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DISPLAY, btn } from './Dialog';

/** Design board B8 states: no shift types yet, empty week, loading skeleton, first-use coach. */

export function NoShiftTypes(props: { onAdd: () => void; onImport: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border-strong bg-surface px-5 py-6 text-center">
      <Clock3 aria-hidden="true" className="h-7 w-7 text-accent" />
      <p className={cn(DISPLAY, 'text-2xl')}>Set up your shift times first</p>
      <p className="max-w-md text-sm text-muted-foreground">Most venues need three or four: for example Morning 07–16, Mid 11–20, Evening 16–01. You can change them any time.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" onClick={props.onAdd} disabled={props.disabled} className={cn(btn.base, btn.sm, btn.gold)}>
          Add shift types
        </button>
        <button type="button" onClick={props.onImport} className={cn(btn.base, btn.sm, btn.plain)}>
          Import a roster · we suggest them
        </button>
      </div>
    </div>
  );
}

export function EmptyWeekPrompt(props: { lastWeek: { shifts: number; people: number } | null; disabled: boolean; onCopy: () => void; onTemplate: () => void; onVoice: () => void }) {
  const { lastWeek, disabled } = props;
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-border-strong bg-surface p-4">
      <p className="text-base font-semibold">Start from last week?</p>
      <p className="text-sm text-muted-foreground">
        {lastWeek && lastWeek.shifts > 0
          ? `Last week had ${lastWeek.shifts} shifts for ${lastWeek.people} people. Copy it and adjust, load a template, or build it by voice.`
          : 'Drag a shift time onto a person’s day, load a template, or build it by voice.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {lastWeek && lastWeek.shifts > 0 && (
          <button type="button" onClick={props.onCopy} disabled={disabled} className={cn(btn.base, btn.sm, btn.gold)}>
            Copy last week
          </button>
        )}
        <button type="button" onClick={props.onTemplate} disabled={disabled} className={cn(btn.base, btn.sm, btn.plain)}>
          Load template
        </button>
        <button type="button" onClick={props.onVoice} className={cn(btn.base, btn.sm, btn.ghost)}>
          <Mic aria-hidden="true" className="h-4 w-4" /> Build by voice
        </button>
      </div>
    </div>
  );
}

/** Header, names and dividers would come from cache; cells shimmer (static under reduced motion). */
export function GridSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the week" className="overflow-hidden rounded-[14px] border border-border bg-background">
      <div className="h-12 border-b border-border-strong bg-surface" />
      <div className="h-14 border-b border-border-strong bg-surface" />
      {Array.from({ length: 6 }, (_, r) => (
        <div key={r} className="grid grid-cols-[150px_repeat(7,minmax(0,1fr))] gap-px border-b border-border/60">
          <div className="m-3 h-4 w-24 rounded bg-surface-raised motion-safe:animate-pulse" />
          {Array.from({ length: 7 }, (_, c) => (
            <div key={c} className="m-1.5 h-[52px] rounded-[10px] bg-[color-mix(in_oklab,var(--text)_6%,transparent)] motion-safe:animate-pulse" />
          ))}
        </div>
      ))}
    </div>
  );
}

const COACH = [
  { title: 'Drag a shift time onto a person’s day', body: 'Or focus a cell and press its number key. Click a shift to change it.' },
  { title: 'Move days off when someone asks', body: 'Requests wait in the strip above the grid; approve or decline there.' },
  { title: 'Publish when it’s ready', body: 'Staff see nothing until you do. Edits after publish tell only the people who changed.' },
];

/** First-use coach: three steps, skippable, shown once per device. */
export function Coach(props: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const last = step === COACH.length - 1;
  return (
    <Dialog title="Welcome to the rota builder" eyebrow="Three things to know · 20 seconds" onClose={props.onDone} width="sm">
      <ol className="space-y-2">
        {COACH.map((c, i) => (
          <li key={c.title} aria-current={i === step ? 'step' : undefined} className={cn('flex gap-3 rounded-xl border p-3', i === step ? 'border-accent bg-accent/10' : 'border-border opacity-60')}>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-bold text-accent-foreground">{i + 1}</span>
            <span>
              <span className="block text-sm font-semibold">{c.title}</span>
              <span className="block text-xs text-muted-foreground">{c.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex items-center justify-between gap-2">
        <button type="button" onClick={props.onDone} className={cn(btn.base, btn.sm, btn.ghost)}>
          Skip
        </button>
        <button type="button" data-autofocus onClick={() => (last ? props.onDone() : setStep(step + 1))} className={cn(btn.base, btn.sm, btn.gold)}>
          {last ? 'Start building' : 'Next'}
        </button>
      </div>
    </Dialog>
  );
}
