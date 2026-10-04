import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button, TextButton } from './Button';

export interface BrowserLoginCopy {
  title: string;
  description: string;
  preparing: string;
  instructions: string;
  open: string;
  cancel: string;
  complete: string;
  verifying: string;
}

export const browserLoginCopy = {
  title: '浏览器登录', description: '完成官方登录，自动保存登录态', preparing: '正在准备浏览器…',
  open: '打开浏览器', cancel: '取消登录', complete: '我已登录', verifying: '正在验证…',
};

/** Browser-login content only; the parent owns the dialog and login lifecycle. */
export default function BrowserLogin({ active, busy, copy, preview, onStart, onOpen, onCancel, onComplete }: {
  active: boolean; busy: boolean; copy: BrowserLoginCopy; preview?: ReactNode;
  onStart: () => void; onOpen: () => void; onCancel: () => void; onComplete: () => void;
}) {
  return active ? <div className="space-y-5">
    <p className="text-sm leading-6 text-gray-300">{copy.instructions}</p>
    <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-2">
      <TextButton className="shrink-0 whitespace-nowrap text-sm" disabled={busy} onClick={onOpen}>{copy.open}</TextButton>
      <div className="flex shrink-0 gap-2">
        <Button className="w-28 shrink-0 whitespace-nowrap" disabled={busy} onClick={onCancel}>{copy.cancel}</Button>
        <Button className="w-28 shrink-0 whitespace-nowrap" variant="primary" disabled={busy} onClick={onComplete}>{busy ? copy.verifying : copy.complete}</Button>
      </div>
    </div>
  </div> : <button type="button" disabled={busy} onClick={onStart} className="group relative flex min-h-40 w-full items-center justify-between gap-3 overflow-hidden rounded-xl border border-gray-700 bg-gray-800/60 text-left transition-colors hover:border-blue-500/60 hover:bg-gray-800 disabled:cursor-wait">
    <span className="relative z-10 flex-1 px-5 py-5">
      <span className="flex items-center gap-2 text-base font-medium text-white">{busy && <Loader2 size={18} className="animate-spin" />}{busy ? copy.preparing : copy.title}</span>
      <span className="mt-2 block text-xs leading-5 text-gray-400">{copy.description}</span>
    </span>
    {preview}
  </button>;
}
