import { useEffect, useRef } from 'react';

/**
 * Open overlays (modals, the mobile nav drawer) in the order they opened, so
 * the Android hardware/gesture Back can close the topmost one — the way
 * every native app behaves — instead of navigating away underneath it or
 * closing the app. Escape keeps working as before; this only adds Back.
 */
const stack: Array<{ id: number; close: () => void }> = [];
let seq = 0;

/** Closes the most recently opened overlay. Returns false if none was open. */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

/** Registers an overlay while `open` is true. */
export function useBackButtonClose(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const entry = { id: ++seq, close: () => closeRef.current() };
    stack.push(entry);
    return () => {
      const i = stack.findIndex(e => e.id === entry.id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}
