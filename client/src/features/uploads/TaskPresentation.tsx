import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ActionRow } from '../../components/Button';
import { AlertCircle, Check, Copy, Download, FileArchive, FolderOpen, Loader2, LockKeyhole, Pause, Upload } from 'lucide-react';
import type { UploadTask } from '../../../../shared/types';
import { MegaIcon, PixivIcon } from '../../components/ImportSources';
import { taskFailureLabel, taskProgressDisplay, taskStates, type TaskTone } from './task-display';

const statusIcons = { uploading: Upload, downloading: Download, processing: Loader2, paused: Pause,
  needs_file: Upload, password: LockKeyhole, duplicate: Copy, completed: Check, failed: AlertCircle };

/** Cards reserve title/status columns; notifications fit the same content naturally. */
export function TaskSummaryContent({ task, message, layout = 'card', expanded = false }: { task: UploadTask; message?: string; layout?: 'card' | 'toast'; expanded?: boolean }) {
  const state = taskStates[task.status];
  const StatusIcon = statusIcons[task.status];
  const progress = taskProgressDisplay(task);
  const active = ['uploading', 'downloading'].includes(task.status);
  const hasProgress = !expanded && active && progress.percentage !== undefined;
  const label = task.status === 'failed' ? taskFailureLabel(task) : message ?? (task.status === 'processing' ? progress.label : state.label);
  return <span className={`w-full min-w-0 items-center text-xs font-normal ${layout === 'toast' ? 'flex gap-2' : 'grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3'}`}>
    <TaskSourceTitle source={task.source} name={task.name} />
    <span className={`flex min-w-0 items-center gap-1.5 ${taskToneStyles[state.tone].icon} ${layout === 'toast' ? 'max-w-[60%] shrink-0' : ''}`}>
      {!hasProgress && <StatusIcon size={14} aria-hidden="true" className={`shrink-0 ${task.status === 'processing' ? 'animate-spin' : ''}`} />}
      {hasProgress ? <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage} className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
          <span className="block h-full rounded-full bg-blue-500 transition-[width] duration-300" style={{ width: `${progress.percentage}%` }} />
      </span> : <span className="min-w-0 truncate" title={label}>{label}</span>}
    </span>
  </span>;
}

export function TaskSourceTitle({ source, name, expanded = false }: { source: UploadTask['source']; name: string; expanded?: boolean }) {
  const sourceLabel = { archive: '压缩包', folder: '文件夹', mega: 'MEGA', pixiv: 'Pixiv' }[source];
  return <span className="upload-source-title" data-expanded={expanded}>
    <span className="upload-source-icon" title={sourceLabel} aria-label={sourceLabel}>
      {source === 'mega' ? <MegaIcon className="h-full w-full" />
        : source === 'pixiv' ? <PixivIcon className="h-full w-full" />
        : source === 'folder' ? <FolderOpen width="100%" height="100%" aria-hidden="true" />
        : <FileArchive width="100%" height="100%" aria-hidden="true" />}
    </span>
    <span className="min-w-0 truncate" title={name}>{name}</span>
  </span>;
}

const taskToneStyles = {
  neutral: { border: '', panel: 'border-gray-700 bg-gray-800/50', text: 'text-gray-400', icon: 'text-gray-400' },
  warning: { border: 'border-amber-500/60', panel: 'border-amber-800/50 bg-amber-500/10', text: 'text-amber-300', icon: 'text-amber-400' },
  success: { border: 'border-green-700/70', panel: 'border-green-800/50 bg-green-900/20', text: 'text-green-300', icon: 'text-green-400' },
  error: { border: 'border-red-500/60', panel: 'border-red-800/50 bg-red-900/20', text: 'text-red-300', icon: 'text-red-400' },
} satisfies Record<TaskTone, { border: string; panel: string; text: string; icon: string }>;

/** Add separation before the visible action surface, beyond the body's 8px gap. */
export function TaskActionRow({ children }: { children: ReactNode }) {
  return <ActionRow className="mt-1">{children}</ActionRow>;
}

/** Task body copy uses 12px type and an 8px rhythm; primary actions keep their normal size. */
export function TaskNotice({ children, tone, role = 'status' }: { children: ReactNode; tone: TaskTone; role?: 'status' | 'alert' }) {
  const style = taskToneStyles[tone];
  return <p role={role} className={`break-words rounded-lg border px-3 py-2 text-xs leading-5 ${style.panel} ${style.text}`}>{children}</p>;
}

export function TaskTextAction({ className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type={type} className={`inline-flex items-center gap-1 self-start rounded py-0.5 text-xs leading-4 text-gray-500 transition-colors hover:text-gray-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-50 ${className}`} />;
}

export function TaskSurface({ task, expanded, children }: { task: UploadTask; expanded: boolean; children: ReactNode }) {
  const border = taskToneStyles[taskStates[task.status].tone].border;
  return <article className={`overflow-hidden rounded-xl border bg-gray-900 transition-colors ${border || (expanded ? 'border-gray-700' : 'border-gray-800 hover:border-gray-600')}`}>{children}</article>;
}
