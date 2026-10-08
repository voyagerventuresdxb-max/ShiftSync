import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VoiceOrb, type OrbStats } from '@/components/shiftsync/VoiceOrb';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { ORB_PERSONALITIES, orbLook, type OrbPhase, type OrbVariant } from '@/lib/voiceOrb';
import { VoiceStage } from '@/components/shiftsync/VoiceStage';
import { VoiceCommandSheet } from '@/components/shiftsync/VoiceCommandSheet';
import { voiceContextLine } from '@/lib/voiceStage';
import { PREVIEW_STATES, PREVIEW_VENUE } from './voicePreviewStates';

/**
 * DEVELOPMENT ONLY (registered in router.tsx behind `import.meta.env.DEV`, so production builds
 * leave it out): the voice orb in every step, for both personalities, with frame measurements.
 *
 *   /dev/voice?variant=a&phase=listening      one orb (simulated voice while listening)
 *   /dev/voice?view=grid&variant=b            every step side by side
 *   &stats=1                                  frame times on screen and on window.__voiceOrbStats
 *   /dev/voice?view=stage&state=confirm-shoutout&variant=b   the whole voice sheet in one state
 *                                             (states: dev/voicePreviewStates.tsx)
 */

const PHASES: OrbPhase[] = ['ready', 'listening', 'transcribing', 'understanding', 'confirm', 'choose', 'rereading', 'sending', 'unclear', 'problem'];

/** A speech-like level for the listening orb without a microphone: syllables in bursts, short pauses. */
function useSimulatedVoice(on: boolean) {
  const level = useRef<number | null>(0);
  useEffect(() => {
    if (!on) return;
    const started = performance.now();
    const timer = setInterval(() => {
      const t = (performance.now() - started) / 1000;
      const phrase = (Math.sin(t * 0.9) + 1) / 2 > 0.25 ? 1 : 0;
      const syllable = Math.max(0, Math.sin(t * 9.5) * 0.6 + Math.sin(t * 4.1) * 0.4);
      level.current = 0.01 + phrase * syllable * 0.09;
    }, 40);
    return () => clearInterval(timer);
  }, [on]);
  return level;
}

export default function VoicePreviewRoute() {
  const [params, setParams] = useSearchParams();
  const variant: OrbVariant = params.get('variant') === 'b' ? 'b' : 'a';
  const phase = (PHASES as string[]).includes(params.get('phase') ?? '') ? (params.get('phase') as OrbPhase) : 'listening';
  const grid = params.get('view') === 'grid';
  const showStats = params.get('stats') === '1';
  const reduced = useReducedMotion();
  const level = useSimulatedVoice(true);
  const [stats, setStats] = useState<OrbStats | null>(null);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };
  const onStats = (s: OrbStats) => {
    setStats(s);
    (window as unknown as { __voiceOrbStats?: OrbStats }).__voiceOrbStats = s;
  };

  if (params.get('view') === 'stage') {
    const name = params.get('state') ?? 'listening';
    const preview = (PREVIEW_STATES[name] ?? PREVIEW_STATES.listening!)();
    const { backToChoices, ...sheet } = preview.sheet ?? { backToChoices: false };
    return (
      <VoiceStage
        state={preview.state}
        variant={variant}
        context={voiceContextLine(PREVIEW_VENUE, 'MANAGER')}
        heard={preview.heard}
        level={level}
        composerText={preview.composerText}
        examples={['Who\x27s working tonight?', 'Add an open bartender shift tomorrow 6pm to 2am', 'Any pending requests?']}
        onComposerChange={() => {}}
        onSend={() => {}}
        onMic={() => {}}
        onClose={() => {}}
      >
        {preview.sheet && (
          <VoiceCommandSheet
            {...(sheet as Required<typeof preview>['sheet'])}
            onConfirm={() => {}}
            onChoose={() => {}}
            onReparse={() => {}}
            onCancel={() => {}}
            onBackToChoices={backToChoices ? () => {} : undefined}
          />
        )}
      </VoiceStage>
    );
  }

  return (
    <div className="min-h-dvh bg-background px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))] text-foreground">
      <p className="eyebrow">Development preview · not in production builds</p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Personality">
        {(['a', 'b'] as const).map((v) => (
          <button key={v} type="button" className={v === variant ? 'btn btn-primary' : 'btn btn-ghost'} onClick={() => set('variant', v)}>
            {v === 'a' ? 'A · recommended' : 'B · alternative'}
          </button>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => set('view', grid ? 'one' : 'grid')}>
          {grid ? 'One orb' : 'All steps'}
        </button>
      </div>
      {grid ? (
        <div className="mt-6 grid grid-cols-3 gap-3">
          {PHASES.map((p) => (
            <div key={p} className="flex flex-col items-center gap-2 rounded-xl border border-border p-2">
              <VoiceOrb look={orbLook(p, reduced)} size={96} personality={ORB_PERSONALITIES[variant]} level={level} reducedMotion={reduced} />
              <span className="text-xs text-foreground/60">{p}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Step">
            {PHASES.map((p) => (
              <button key={p} type="button" className={p === phase ? 'chip active' : 'chip'} onClick={() => set('phase', p)}>
                {p}
              </button>
            ))}
          </div>
          <div className="mt-10 grid place-items-center">
            <VoiceOrb
              look={orbLook(phase, reduced)}
              size={176}
              personality={ORB_PERSONALITIES[variant]}
              level={level}
              reducedMotion={reduced}
              onStats={showStats ? onStats : undefined}
            />
          </div>
          {showStats && stats && (
            <pre className="mt-6 text-xs text-foreground/60" data-testid="orb-stats">
              {JSON.stringify(stats)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
