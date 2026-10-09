/**
 * Colour tokens for canvas code, which cannot use `var(--…)`: read the token from the
 * stylesheet at runtime (src/styles/tokens.css) and build the canvas colour string from it.
 * The one place outside tokens.css allowed to write a colour value (scripts/palette-allowlist.json).
 */
export type Rgb = { r: number; g: number; b: number };

/** Used only before the stylesheet can be read (tests, no DOM); equals `--accent` (asserted in scripts/palette-contrast.test.mjs). */
export const FALLBACK_ACCENT = '#c9a66b';

/** A `#rrggbb` token as RGB, or the fallback when the token can't be read. */
export function tokenRgb(name: string, fallback: string = FALLBACK_ACCENT): Rgb {
  const raw = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)?.[1] ?? fallback.slice(1);
  const n = parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Canvas fill/stroke string for an RGB colour, optionally with alpha. */
export function cssRgb({ r, g, b }: Rgb, alpha?: number): string {
  const rgb = `${Math.round(r)},${Math.round(g)},${Math.round(b)}`;
  return alpha === undefined ? `rgb(${rgb})` : `rgba(${rgb},${alpha})`;
}
