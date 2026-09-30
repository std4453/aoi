import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertCircle, CheckCircle, Info, AlertTriangle, Loader2 } from 'lucide-react';

type ToastType = 'default' | 'info' | 'success' | 'error' | 'warning' | 'loading';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
}

let nextId = 0;

type AddToastListener = (message: string, type?: ToastType) => number;
type RemoveToastListener = (id: number) => void;

let addListener: AddToastListener | null = null;
let removeListener: RemoveToastListener | null = null;

function addToast(message: string, type: ToastType = 'default'): number {
  return addListener?.(message, type) ?? -1;
}

function removeToast(id: number): void {
  removeListener?.(id);
}

/** Show a default (gray) toast. Auto-dismisses after 2.5s. */
export function showToast(message: string): void {
  addToast(message, 'default');
}

/** Show an info (blue) toast. Auto-dismisses after 2.5s. */
export function showInfo(message: string): void {
  addToast(message, 'info');
}

/** Show a success (green) toast. Auto-dismisss after 2.5s. */
export function showSuccess(message: string): void {
  addToast(message, 'success');
}

/** Show an error (red) toast. Auto-dismisses after 3s. */
export function showError(message: string): void {
  addToast(message, 'error');
}

/** Show a warning (yellow) toast. Auto-dismisses after 3s. */
export function showWarning(message: string): void {
  addToast(message, 'warning');
}

/**
 * Show a loading toast with a spinner. Stays until explicitly closed.
 * Returns a function to close it.
 */
export function showLoading(message: string): () => void {
  const id = addToast(message, 'loading');
  return () => removeToast(id);
}

// --- Type config ---

const TYPE_CONFIG: Record<ToastType, {
  icon: typeof Info;
  bg: string;
  border: string;
  text: string;
  iconClass: string;
  duration: number | null; // null = no auto-dismiss
}> = {
  default: {
    icon: Info,
    bg: 'bg-gray-800',
    border: 'border-gray-700',
    text: 'text-gray-200',
    iconClass: 'text-gray-400',
    duration: 2500,
  },
  info: {
    icon: Info,
    bg: 'bg-blue-950/90',
    border: 'border-blue-700/50',
    text: 'text-blue-100',
    iconClass: 'text-blue-400',
    duration: 2500,
  },
  success: {
    icon: CheckCircle,
    bg: 'bg-green-950/90',
    border: 'border-green-700/50',
    text: 'text-green-100',
    iconClass: 'text-green-400',
    duration: 2500,
  },
  error: {
    icon: AlertCircle,
    bg: 'bg-red-950/90',
    border: 'border-red-700/50',
    text: 'text-red-100',
    iconClass: 'text-red-400',
    duration: 3000,
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-yellow-950/90',
    border: 'border-yellow-700/50',
    text: 'text-yellow-100',
    iconClass: 'text-yellow-400',
    duration: 3000,
  },
  loading: {
    icon: Loader2,
    bg: 'bg-gray-800',
    border: 'border-gray-700',
    text: 'text-gray-200',
    iconClass: 'text-gray-400',
    duration: null,
  },
};

const EXIT_DURATION = 150; // ms, matches CSS animation

// --- Component ---

export default function Toast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timerRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismissNow = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = timerRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timerRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: number) => {
    // Don't dismiss loading toasts by click
    setToasts(prev => {
      const t = prev.find(x => x.id === id);
      if (!t || t.type === 'loading' || t.exiting) return prev;
      return prev.map(x => x.id === id ? { ...x, exiting: true } : x);
    });
    // Remove from DOM after exit animation
    setTimeout(() => dismissNow(id), EXIT_DURATION);
    // Clear auto-dismiss timer
    const timer = timerRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timerRef.current.delete(id);
    }
  }, [dismissNow]);

  useEffect(() => {
    addListener = (message: string, type: ToastType = 'default') => {
      const id = nextId++;
      setToasts(prev => [...prev, { id, message, type, exiting: false }]);

      const duration = TYPE_CONFIG[type].duration;
      if (duration !== null) {
        const timer = setTimeout(() => dismiss(id), duration);
        timerRef.current.set(id, timer);
      }

      return id;
    };

    removeListener = (id: number) => {
      // Trigger exit animation then remove
      setToasts(prev => {
        const t = prev.find(x => x.id === id);
        if (!t || t.exiting) return prev;
        return prev.map(x => x.id === id ? { ...x, exiting: true } : x);
      });
      // Clear auto-dismiss timer
      const timer = timerRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timerRef.current.delete(id);
      }
      setTimeout(() => dismissNow(id), EXIT_DURATION);
    };

    return () => {
      addListener = null;
      removeListener = null;
    };
  }, [dismiss, dismissNow]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map(t => {
        const cfg = TYPE_CONFIG[t.type];
        const Icon = cfg.icon;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2.5 ${cfg.bg} border ${cfg.border} ${cfg.text} text-sm px-4 py-3 rounded-xl shadow-lg ${t.exiting ? 'animate-toast-exit' : 'animate-toast-enter'} w-max max-w-[90vw]`}
            onClick={() => dismiss(t.id)}
          >
            <Icon size={16} className={`${cfg.iconClass} shrink-0 ${t.type === 'loading' ? 'animate-spin' : ''}`} />
            <span className="flex-1">{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}
