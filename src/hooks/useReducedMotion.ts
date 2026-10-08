import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {};
  const mq = matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** Live `prefers-reduced-motion: reduce` (iPhone: Settings → Accessibility → Motion → Reduce Motion). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof matchMedia !== 'undefined' && matchMedia(QUERY).matches,
    () => false,
  );
}
