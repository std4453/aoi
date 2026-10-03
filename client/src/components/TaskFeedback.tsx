import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { taskToneStyles, type TaskTone } from '../lib/upload-task-display';

/** Task body copy uses 12px type and an 8px rhythm; primary actions keep their normal size. */
export function TaskNotice({ children, tone, role = 'status' }: { children: ReactNode; tone: TaskTone; role?: 'status' | 'alert' }) {
  const style = taskToneStyles[tone];
  return <p role={role} className={`break-words rounded-lg border px-3 py-2 text-xs leading-5 ${style.panel} ${style.text}`}>{children}</p>;
}

export function TaskTextAction({ className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type={type} className={`inline-flex items-center gap-1 self-start rounded py-0.5 text-xs leading-4 text-gray-500 transition-colors hover:text-gray-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-50 ${className}`} />;
}
