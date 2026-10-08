import type { OrbVariant } from '@/lib/voiceOrb';

/**
 * Which voice sheet layout the app shows: always the recommended one. On a preview-only branch
 * the build configuration may replace this module for preview deployments; every other build
 * (local, CI, production) uses this file.
 */
export function voiceVariant(): OrbVariant {
  return 'a';
}
