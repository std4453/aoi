import { AlertCircle, Check, Copy, Download, FileArchive, FolderOpen, Loader2, LockKeyhole, Pause, Upload } from 'lucide-react';
import type { UploadTask } from '../../../shared/types';
import { MegaIcon, PixivIcon } from './ImportSources';
import { taskFailureLabel, taskProgressDisplay } from '../lib/upload-task-display';

const states = {
  uploading: { label: '上传中', Icon: Upload, color: 'text-gray-400' },
  downloading: { label: '下载中', Icon: Download, color: 'text-gray-400' },
  processing: { label: '处理中', Icon: Loader2, color: 'text-gray-400' },
  paused: { label: '已暂停', Icon: Pause, color: 'text-gray-400' },
  needs_file: { label: '待选择文件', Icon: Upload, color: 'text-amber-400' },
  password: { label: '待输入密码', Icon: LockKeyhole, color: 'text-amber-400' },
  duplicate: { label: '待确认重复', Icon: Copy, color: 'text-amber-400' },
  completed: { label: '已完成', Icon: Check, color: 'text-green-400' },
  failed: { label: '失败', Icon: AlertCircle, color: 'text-red-400' },
} as const;

/** Cards reserve title/status columns; notifications fit the same content naturally. */
export function TaskSummaryContent({ task, message, layout = 'card', expanded = false }: { task: UploadTask; message?: string; layout?: 'card' | 'toast'; expanded?: boolean }) {
  const state = states[task.status];
  const StatusIcon = state.Icon;
  const progress = taskProgressDisplay(task);
  const active = ['uploading', 'downloading'].includes(task.status);
  const hasProgress = !expanded && active && progress.percentage !== undefined;
  const label = task.status === 'failed' ? taskFailureLabel(task) : message ?? (task.status === 'processing' ? progress.label : state.label);
  return <span className={`w-full min-w-0 items-center text-xs font-normal ${layout === 'toast' ? 'flex gap-2' : 'grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3'}`}>
    <TaskSourceTitle source={task.source} name={task.name} />
    <span className={`flex min-w-0 items-center gap-1.5 ${state.color} ${layout === 'toast' ? 'max-w-[60%] shrink-0' : ''}`}>
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
