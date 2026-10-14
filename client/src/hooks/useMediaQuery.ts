import { useCallback, useSyncExternalStore } from 'react';

/**
 * Live `window.matchMedia(query).matches`. Correct on the first render (no
 * flash of the wrong layout) and re-renders when the query flips, e.g. on
 * rotation or a desktop window resize.
 *
 * Prefer plain responsive CSS classes. Use this only where the two layouts
 * are different DOM (DataTable's table vs. card list), so both trees are not
 * rendered at once — duplicated hidden markup doubles the work and confuses
 * text-based test selectors.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mq = window.matchMedia(query);
    mq.addEventListener?.('change', cb);
    return () => mq.removeEventListener?.('change', cb);
  }, [query]);
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true);
  return useSyncExternalStore(subscribe, get, () => true);
}

/** Tailwind's `md` breakpoint (768px): tables on md+, card lists below. */
export const MD_UP = '(min-width: 768px)';
