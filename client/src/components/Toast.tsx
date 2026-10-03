import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertCircle, CheckCircle, Info, AlertTriangle, Loader2, Check, ChevronRight } from 'lucide-react';
import type { UploadTask } from '../../../shared/types';
import { IconButton } from './Button';
import { TaskSummaryContent } from './TaskSummary';

type ToastType = 'default' | 'info' | 'success' | 'error' | 'warning' | 'loading';

interface ToastOptions {
  position?: 'top' | 'bottom';
  duration?: number | null;
  onClick?: () => void;
  action?: { label: string; onClick: () => void; ariaLabel?: string; icon?: 'check' | 'arrow' };
  task?: UploadTask;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
  options: ToastOptions;
}

let nextId = 0;

type AddToastListener = (message: string, type?: ToastType, options?: ToastOptions) => number;
type RemoveToastListener = (id: number) => void;

let addListener: AddToastListener | null = null;
let removeListener: RemoveToastListener | null = null;
let updateTaskListener: ((id: number, task: UploadTask, options: TaskToastOptions) => void) | null = null;

function addToast(message: string, type: ToastType = 'default'): number {
  return addListener?.(message, type) ?? -1;
}

function removeToast(id: number): void {
  removeListener?.(id);
}

/** Persistent task notification with one action and an independently clickable body. */
export interface TaskToastHandle {
  close: () => void;
  update: (task: UploadTask, options: TaskToastOptions) => void;
}

type TaskToastOptions = Omit<ToastOptions, 'position' | 'duration' | 'task'> & { message?: string };

function taskToastType(task: UploadTask): ToastType {
  return task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : 'warning';
}

export function showTaskToast(task: UploadTask, options: TaskToastOptions): TaskToastHandle {
  const { message = '', ...actions } = options;
  const id = addListener?.(message, taskToastType(task), { ...actions, task, position: 'bottom', duration: null }) ?? -1;
  return { close: () => removeToast(id), update: (next, nextOptions) => updateTaskListener?.(id, next, nextOptions) };
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
    addListener = (message: string, type: ToastType = 'default', options: ToastOptions = {}) => {
      const id = nextId++;
      setToasts(prev => [...prev, { id, message, type, exiting: false, options }]);

      const duration = options.duration === undefined ? TYPE_CONFIG[type].duration : options.duration;
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

    updateTaskListener = (id, task, options) => {
      const { message = '', ...actions } = options;
      setToasts(prev => prev.map(toast => toast.id === id && !toast.exiting
        ? { ...toast, message, type: taskToastType(task), options: { ...toast.options, ...actions, task } }
        : toast));
    };

    return () => {
      addListener = null;
      removeListener = null;
      updateTaskListener = null;
      timerRef.current.forEach(clearTimeout);
      timerRef.current.clear();
    };
  }, [dismiss, dismissNow]);

  if (toasts.length === 0) return null;

  return (
    <>{(['top', 'bottom'] as const).map(position => <div key={position} className={`fixed left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none ${position === 'top' ? 'top-[max(1rem,env(safe-area-inset-top))]' : 'bottom-[calc(5rem+env(safe-area-inset-bottom))] [:root:has([data-image-viewer])_&]:bottom-[calc(7rem+env(safe-area-inset-bottom))] max-h-[40dvh] overflow-y-auto max-w-[90vw]'}`} aria-live="polite">
      {toasts.filter(t => (t.options.position ?? 'top') === position).map(t => {
        const cfg = TYPE_CONFIG[t.type];
        const Icon = cfg.icon;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2 ${cfg.bg} border ${cfg.border} ${cfg.text} text-sm rounded-xl shadow-lg backdrop-blur-md ${t.exiting ? 'animate-toast-exit' : 'animate-toast-enter'} ${position === 'bottom' ? 'w-max max-w-[90vw] px-2 py-1' : 'w-max max-w-[90vw] px-4 py-3'}`}
          >
            {!t.options.task && <Icon size={16} className={`${cfg.iconClass} shrink-0 ${t.type === 'loading' ? 'animate-spin' : ''}`} />}
            <button type="button" className={`flex-1 min-w-0 text-left ${t.options.task ? 'py-1' : 'break-words'}`} onClick={() => { t.options.onClick?.(); if (t.type !== 'loading') dismiss(t.id); }}>
              {t.options.task ? <TaskSummaryContent task={t.options.task} message={t.message || undefined} layout="toast" /> : t.message}
            </button>
            {t.options.action && <IconButton className="h-7 w-7" label={t.options.action.ariaLabel ?? t.options.action.label}
              icon={t.options.action.icon === 'check' ? <Check size={16} /> : <ChevronRight size={16} />}
              onClick={event => { event.stopPropagation(); t.options.action!.onClick(); }} />}
          </div>
        );
      })}
    </div>)}</>
  );
}
