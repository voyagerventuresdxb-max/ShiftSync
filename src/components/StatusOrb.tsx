import { Component, Suspense, lazy, type ReactNode } from 'react';
import { loadVoiceOrb } from '@/components/shiftsync/voiceOrbChunk';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { ORB_PERSONALITIES } from '@/lib/voiceOrb';
import { statusOrbLook, type StatusOrbPhase } from '@/lib/statusOrb';

// The voice sheet's orb, from its own download (the same chunk voice uses).
const VoiceOrb = lazy(() => loadVoiceOrb().then((m) => ({ default: m.VoiceOrb })));

/**
 * A still ring of gold dots: shown at once while the orb's download arrives, and for good if it
 * fails, so the screen never waits on it or breaks without it.
 */
export function StaticOrbRing({ size, dim = false }: { size: number; dim?: boolean }) {
  const dots = 28;
  const r = size * 0.36;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" data-testid="static-orb-ring" style={{ display: 'block' }}>
      {Array.from({ length: dots }, (_, i) => {
        const a = (i / dots) * Math.PI * 2;
        return <circle key={i} cx={size / 2 + Math.cos(a) * r} cy={size / 2 + Math.sin(a) * r} r={Math.max(1, size / 80)} style={{ fill: 'var(--accent)' }} opacity={dim ? 0.3 : 0.7} />;
      })}
    </svg>
  );
}

class OrbBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The gold dot orb for a step outside voice (onboarding). Decorative: hidden from screen readers. */
export function StatusOrb({ phase, size, className }: { phase: StatusOrbPhase; size: number; className?: string }) {
  const reduced = useReducedMotion();
  const ring = <StaticOrbRing size={size} dim={phase === 'problem'} />;
  return (
    <div className={className} aria-hidden="true" data-orb-phase={phase} style={{ width: size, height: size }}>
      <OrbBoundary fallback={ring}>
        <Suspense fallback={ring}>
          <VoiceOrb look={statusOrbLook(phase, reduced)} size={size} personality={ORB_PERSONALITIES.a} reducedMotion={reduced} />
        </Suspense>
      </OrbBoundary>
    </div>
  );
}
