import type { OrbVariant } from '@/lib/voiceOrb';

/**
 * PREVIEW ONLY — branch `preview/r15-voice-variant-b`, never merged. vite.config.ts uses this file
 * for `@/voiceVariant` only when VERCEL_ENV is "preview", so a production build never contains it
 * (checked against the build output). Open any page with ?variant=b (or ?variant=a to go back);
 * the choice is kept for the tab, so it survives the sign-in redirect.
 */
const KEY = 'shiftsync.voiceVariantPreview';

export function voiceVariant(): OrbVariant {
  try {
    const asked = new URLSearchParams(window.location.search).get('variant');
    if (asked === 'a' || asked === 'b') sessionStorage.setItem(KEY, asked);
    return sessionStorage.getItem(KEY) === 'b' ? 'b' : 'a';
  } catch {
    return 'a';
  }
}
