import type { ReactNode } from 'react';
import './onboarding.css';

/**
 * Shared chrome across Venue/Roster/Review/Invite (Welcome is its own
 * immersive full-bleed thing, no shell) — ambient background, rim light,
 * logo lockup, Back link, and the 5-step progress rail, ported 1:1 from the
 * prototype's repeated per-screen markup (`ShiftSync Venue/Roster/Review/
 * Invite.dc.html` all share this exact structure). The prototype's own
 * phone-bezel/iOS-status-bar/home-indicator chrome is presentation-only and
 * dropped here, same reasoning as WelcomeScreen.
 */
// The Welcome intro (hold gesture + carousel) is the app's launch moment,
// not a step with anything to fill in — the rail starts at Account, the
// wizard's first real step since account creation moved into it
// (2026-09-16).
const STEP_LABELS = ['Account', 'Venue', 'Roster', 'Review', 'Invite'];

export function StepProgress({ currentIndex }: { currentIndex: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
      {STEP_LABELS.map((label, i) => {
        const past = i < currentIndex;
        const current = i === currentIndex;
        return (
          <div
            key={label}
            aria-label={current ? `Step ${i + 1}: ${label} (current)` : `Step ${i + 1}: ${label}`}
            style={{
              width: current ? 26 : 18,
              height: 2,
              borderRadius: 1,
              background: current ? 'var(--ob-champagne)' : past ? 'var(--ob-bronze)' : 'var(--ob-bone)',
              opacity: current ? 1 : past ? 0.55 : 0.14,
              transition: 'width .3s var(--ob-ease-out), background .3s var(--ob-ease-out), opacity .3s var(--ob-ease-out)',
            }}
          />
        );
      })}
    </div>
  );
}

export default function OnboardingScreenShell({
  stepIndex,
  eyebrow,
  title,
  onBack,
  children,
  footer,
}: {
  /** 0-indexed: Account=0, Venue=1, Roster=2, Review=3, Invite=4. */
  stepIndex: number;
  eyebrow: string;
  title: string;
  onBack?: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="ob-root" style={{ position: 'fixed', inset: 0, zIndex: 50, overflow: 'hidden' }}>
      <div
        style={{
          position: 'fixed',
          inset: '-8%',
          background:
            'radial-gradient(60% 50% at 30% 22%,rgba(201,166,107,.08),transparent 55%),radial-gradient(80% 60% at 78% 78%,rgba(60,40,20,.35),transparent 60%),linear-gradient(180deg,#0A0908 0%,#070605 60%,#050403 100%)',
          animation: 'ob-ambient 14s ease-in-out infinite',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <div
        style={{
          position: 'fixed',
          left: -40,
          top: -40,
          width: '70%',
          height: '60%',
          background: 'radial-gradient(closest-side,rgba(201,166,107,.22),transparent 70%)',
          filter: 'blur(28px)',
          opacity: 0.8,
          pointerEvents: 'none',
          animation: 'ob-rim 9s ease-in-out infinite',
          zIndex: 0,
        }}
      />

      <div className="ob-stage ob-stage--scroll" style={{ zIndex: 1 }}>
      <div style={{ position: 'relative', minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '72px 24px 48px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'ob-fade-in .52s cubic-bezier(.16,1,.3,1) both' }}>
          <img src="/shiftsync-mark.svg" alt="ShiftSync" width={88} height={44} style={{ display: 'block', marginBottom: 10 }} />
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
            <span className="ob-serif" style={{ fontSize: 15, letterSpacing: '.02em', color: 'var(--ob-bone)' }}>
              ShiftSync
            </span>
            <span style={{ display: 'inline-block', width: 1, height: 11, background: 'var(--ob-bronze)', opacity: 0.6 }} />
            <span style={{ font: "500 10px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-bronze)' }}>Manager</span>
          </div>
        </div>

        {onBack && (
          <button
            onClick={onBack}
            style={{
              position: 'absolute',
              left: 24,
              top: 78,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: 8,
              color: 'var(--ob-bronze)',
              font: "500 10px/1 'Manrope'",
              letterSpacing: '.24em',
              textTransform: 'uppercase',
              background: 'transparent',
              border: 0,
              animation: 'ob-fade-in .52s cubic-bezier(.16,1,.3,1) both',
            }}
          >
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 2.5 4.5 7 9 11.5" />
            </svg>
            Back
          </button>
        )}

        <div style={{ marginTop: 32, animation: 'ob-fade-in .52s cubic-bezier(.16,1,.3,1) .08s both' }}>
          <StepProgress currentIndex={stepIndex} />
        </div>

        <div style={{ width: '100%', maxWidth: 480, marginTop: 32, display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div style={{ animation: 'ob-fade-up .52s cubic-bezier(.16,1,.3,1) .16s both' }}>
            <div style={{ font: "500 10px/1 'Manrope'", letterSpacing: '.28em', textTransform: 'uppercase', color: 'var(--ob-dim-2)' }}>{eyebrow}</div>
            <div className="ob-serif" style={{ fontSize: 34, lineHeight: 1.1, color: 'var(--ob-champagne)', letterSpacing: '-.005em', marginTop: 12 }}>
              {title}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 22, marginTop: 30, flex: 1 }}>{children}</div>

          <div style={{ marginTop: 30, paddingBottom: 24, animation: 'ob-fade-up .52s cubic-bezier(.16,1,.3,1) .56s both' }}>{footer}</div>
        </div>
      </div>
      </div>
    </div>
  );
}
