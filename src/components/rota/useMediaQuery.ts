import { useEffect, useState } from 'react';

/**
 * Live `matchMedia` match. Kept dependency-free and tiny on purpose: the
 * Scheduling route (a staff screen) imports it to decide which manager view
 * to lazy-load, so it must not pull the builder in with it.
 */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
