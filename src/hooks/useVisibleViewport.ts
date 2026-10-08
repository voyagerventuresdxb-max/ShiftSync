import { useEffect, useState } from 'react';

export interface VisibleBox {
  /** Distance of the visible area from the top of the layout viewport, CSS px. */
  top: number;
  height: number;
}

function read(): VisibleBox {
  if (typeof window === 'undefined') return { top: 0, height: 0 };
  const vv = window.visualViewport;
  return vv ? { top: vv.offsetTop, height: vv.height } : { top: 0, height: window.innerHeight };
}

/**
 * The part of the screen the person can actually see. On iPhone the on-screen keyboard shrinks
 * only the visual viewport (100vh/100dvh and `position: fixed; bottom: 0` stay behind the
 * keyboard), so a full-screen sheet sized to this box keeps its bottom row above the keyboard.
 */
export function useVisibleViewport(): VisibleBox {
  const [box, setBox] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () =>
      setBox((prev) => {
        const next = read();
        return prev.top === next.top && prev.height === next.height ? prev : next;
      });
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return box;
}
