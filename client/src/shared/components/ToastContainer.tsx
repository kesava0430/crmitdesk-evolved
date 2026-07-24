import { useEffect, useState } from 'react';
import { X, AlertCircle, CheckCircle, Info, AlertTriangle } from 'lucide-react';
import { subscribe, removeToast, Toast } from './toastStore';

const CONFIG: Record<Toast['type'], { icon: React.ReactNode; bg: string; bar: string }> = {
  error:   { icon: <AlertCircle size={17} />,   bg: 'bg-red-50 border-red-200 text-red-800',     bar: 'bg-red-400' },
  success: { icon: <CheckCircle size={17} />,   bg: 'bg-green-50 border-green-200 text-green-800', bar: 'bg-green-400' },
  warning: { icon: <AlertTriangle size={17} />, bg: 'bg-amber-50 border-amber-200 text-amber-800', bar: 'bg-amber-400' },
  info:    { icon: <Info size={17} />,           bg: 'bg-blue-50 border-blue-200 text-blue-800',   bar: 'bg-blue-400' },
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribe(setToasts), []);

  if (!toasts.length) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 w-96 max-w-[calc(100vw-2rem)] pointer-events-none">
      {toasts.map(t => {
        const { icon, bg, bar } = CONFIG[t.type];
        return (
          <div
            key={t.id}
            className={`flex items-start gap-3 p-3 rounded-lg border shadow-lg pointer-events-auto overflow-hidden relative ${bg}`}
          >
            {/* colour bar on left */}
            <span className={`absolute left-0 top-0 bottom-0 w-1 ${bar} rounded-l-lg`} />
            <span className="shrink-0 mt-0.5 ml-2">{icon}</span>
            <p className="text-sm flex-1 leading-snug">{t.message}</p>
            <button
              onClick={() => removeToast(t.id)}
              className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
