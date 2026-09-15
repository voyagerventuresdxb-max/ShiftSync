import { useEffect, useId, useState } from 'react';

/**
 * Liquid-glass sphere — SVG feTurbulence + feDisplacementMap distortion,
 * layered radial gradients (warm gold/cream + specular highlight), backdrop
 * blur, continuous shimmer at rest, compress + intensified turbulence on
 * hold. Pure material/light — no glyph inside. Ported 1:1 from the
 * Welcome prototype's `liquid-sphere.jsx` (SVG filter primitives can't be
 * driven by CSS, hence the RAF-driven state here instead of Framer Motion).
 */
interface LiquidGlassSphereProps {
  size?: number;
  sphereWidth?: number;
  sphereHeight?: number;
  /** True while the user is actively holding — intensifies turbulence + compresses slightly. */
  active?: boolean;
  /** 0 → 1, unused directly here but kept for prototype parity. */
  progress?: number;
  /** 0 → 1 extra displacement amplitude at rest (organic undulating edges). */
  waviness?: number;
  /** Outer translucency — does not touch inner gradients/shader. */
  opacity?: number;
}

export function LiquidGlassSphere({
  size = 128,
  sphereWidth,
  sphereHeight,
  active = false,
  waviness = 0,
  opacity = 1,
}: LiquidGlassSphereProps) {
  const W = sphereWidth || size;
  const H = sphereHeight || size;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  const [t, setT] = useState(0);
  useEffect(() => {
    let raf: number;
    const start = performance.now();
    const tick = (now: number) => {
      setT((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const restBase = 6 + waviness * 36;
  const targetScale = active ? 22 + 10 + waviness * 10 : restBase;
  const [dispScale, setDispScale] = useState(6);
  useEffect(() => {
    let raf: number;
    const step = () => {
      setDispScale((v) => {
        const dv = targetScale - v;
        return Math.abs(dv) < 0.02 ? targetScale : v + dv * 0.08;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [targetScale]);

  const restFreq = 0.014 - waviness * 0.008 + Math.sin(t * (0.35 - waviness * 0.15)) * (0.004 + waviness * 0.002);
  const activeFreq = 0.032 + Math.sin(t * 1.6) * 0.01;
  const baseFreq = active ? activeFreq : restFreq;

  const specX = 28 + Math.sin(t * 0.42) * 2.2;
  const specY = 26 + Math.cos(t * 0.36) * 1.8;
  const specR = 22 + Math.sin(t * 0.3) * 1.4;
  const hueRot = Math.sin(t * 0.28) * 5;

  const Rx = W / 2;
  const Ry = H / 2;

  return (
    <div
      style={{
        width: W,
        height: H,
        position: 'relative',
        pointerEvents: 'none',
        opacity,
        transform: active ? 'scale(.985)' : 'scale(1)',
        transition: 'transform 600ms cubic-bezier(.16,1,.3,1), opacity 600ms cubic-bezier(.16,1,.3,1)',
        willChange: 'transform, opacity',
      }}
    >
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{
          display: 'block',
          filter: `hue-rotate(${hueRot.toFixed(2)}deg) saturate(${(1 + (active ? 0.08 : 0)).toFixed(3)})`,
          transition: 'filter 600ms cubic-bezier(.16,1,.3,1)',
        }}
      >
        <defs>
          <filter id={`liq-${uid}`} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency={baseFreq.toFixed(4)} numOctaves={2} seed={4} result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale={dispScale.toFixed(2)} xChannelSelector="R" yChannelSelector="G" />
            <feGaussianBlur stdDeviation={active ? '0.35' : '0.15'} />
          </filter>

          <radialGradient id={`body-${uid}`} cx="38%" cy="34%" r="68%">
            <stop offset="0%" stopColor="#F5E4C1" stopOpacity="1" />
            <stop offset="38%" stopColor="#D9B37A" stopOpacity=".98" />
            <stop offset="72%" stopColor="#8B7550" stopOpacity=".95" />
            <stop offset="100%" stopColor="#2A1F13" stopOpacity="1" />
          </radialGradient>

          <radialGradient id={`core-${uid}`} cx="58%" cy="72%" r="60%">
            <stop offset="0%" stopColor="#C9A66B" stopOpacity=".55" />
            <stop offset="60%" stopColor="#C9A66B" stopOpacity="0" />
            <stop offset="100%" stopColor="#C9A66B" stopOpacity="0" />
          </radialGradient>

          <radialGradient id={`spec-${uid}`} cx={`${specX}%`} cy={`${specY}%`} r={`${specR}%`}>
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity=".85" />
            <stop offset="40%" stopColor="#FFFBEE" stopOpacity=".35" />
            <stop offset="100%" stopColor="#FFFBEE" stopOpacity="0" />
          </radialGradient>

          <radialGradient id={`rim-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="86%" stopColor="#C9A66B" stopOpacity="0" />
            <stop offset="96%" stopColor="#EFD9A8" stopOpacity=".55" />
            <stop offset="100%" stopColor="#EFD9A8" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g filter={`url(#liq-${uid})`}>
          <ellipse cx={Rx} cy={Ry} rx={Rx - 1} ry={Ry - 1} fill={`url(#body-${uid})`} />
          <ellipse cx={Rx} cy={Ry} rx={Rx - 1} ry={Ry - 1} fill={`url(#core-${uid})`} />
          <ellipse
            cx={Rx * 0.66}
            cy={Ry * 0.5}
            rx={Rx * 0.55}
            ry={Ry * 0.18}
            fill="#FFFBEE"
            opacity=".10"
            transform={`rotate(-28 ${(Rx * 0.66).toFixed(2)} ${(Ry * 0.5).toFixed(2)})`}
          />
          <ellipse cx={Rx} cy={Ry} rx={Rx - 1} ry={Ry - 1} fill={`url(#spec-${uid})`} />
          {waviness > 0.05 && <ellipse cx={Rx} cy={Ry} rx={Rx - 1} ry={Ry - 1} fill={`url(#rim-${uid})`} />}
        </g>

        {waviness < 0.5 && (
          <ellipse cx={Rx} cy={Ry} rx={Rx - 1} ry={Ry - 1} fill={`url(#rim-${uid})`} opacity={1 - waviness * 2} />
        )}

        <ellipse cx={Rx} cy={H - 3} rx={Rx * 0.72} ry={3} fill="#000" opacity=".35" style={{ filter: 'blur(3px)' }} />
      </svg>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          backdropFilter: `blur(${active ? 10 : 6}px) saturate(1.1)`,
          WebkitBackdropFilter: `blur(${active ? 10 : 6}px) saturate(1.1)`,
          transition: 'backdrop-filter 600ms cubic-bezier(.16,1,.3,1), -webkit-backdrop-filter 600ms cubic-bezier(.16,1,.3,1)',
          zIndex: -1,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
