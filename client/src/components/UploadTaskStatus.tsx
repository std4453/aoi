import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle, LoaderCircle, Pause } from 'lucide-react';

export default function UploadTaskStatus({ stage, progress, detail, error, done, paused, children }: {
  stage: string; progress?: number; detail?: string; error?: string | null;
  done?: boolean; paused?: boolean; children?: ReactNode;
}) {
  const Icon = error ? AlertCircle : done ? CheckCircle : paused ? Pause : LoaderCircle;
  return <div className="space-y-4" aria-live="polite">
    <div className="flex items-center gap-2">
      <Icon size={20} className={error ? 'text-red-400' : done ? 'text-green-400' : paused ? 'text-yellow-400' : 'text-blue-400 animate-spin'} />
      <span className="text-sm font-medium text-white">{stage}</span>
      {progress !== undefined && !error && !done && <span className="ml-auto text-sm text-gray-300">{Math.round(progress)}%</span>}
    </div>
    {!done && !error && <div role="progressbar" aria-label={stage} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
        className="h-2 rounded-full overflow-hidden bg-gray-800">
      <div className={`h-full rounded-full ${paused ? 'bg-yellow-500' : 'bg-blue-500'} ${progress === undefined ? `w-1/3 ${paused ? '' : 'animate-pulse'}` : 'transition-all'}`}
        style={progress === undefined ? undefined : { width: `${Math.max(0, Math.min(100, progress))}%` }} />
    </div>}
    {detail && <p className="text-sm text-gray-400">{detail}</p>}
    {error && <p role="alert" className="rounded-xl border border-red-800 bg-red-900/20 p-3 text-sm text-red-300 break-words">{error}</p>}
    <div className="flex flex-wrap gap-2">{children}</div>
  </div>;
}

export const taskActionClass = 'flex-1 min-w-fit rounded-xl bg-gray-800 px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50';
