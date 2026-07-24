// Pure TS module — no React. Can be imported by axios interceptors.

export type ToastType = 'error' | 'success' | 'warning' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();

function notify() {
  const snapshot = [...toasts];
  listeners.forEach(l => l(snapshot));
}

export function addToast(message: string, type: ToastType = 'error', duration = 6000): string {
  const id = Math.random().toString(36).slice(2, 9);
  toasts = [...toasts, { id, message, type }];
  notify();
  if (duration > 0) setTimeout(() => removeToast(id), duration);
  return id;
}

export function removeToast(id: string) {
  toasts = toasts.filter(t => t.id !== id);
  notify();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn([...toasts]); // emit current state immediately
  return () => listeners.delete(fn);
}
