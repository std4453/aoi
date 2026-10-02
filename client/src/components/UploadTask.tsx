import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UploadTaskStatus as Task } from '../../../shared/types';
import { get, post, del } from '../api/client';
import { clearPacksCache } from '../lib/homeStore';
import { rememberUploadTask, forgetUploadTask } from '../lib/uploadTask';
import UploadTaskStatus, { taskActionClass } from './UploadTaskStatus';
import DuplicateUploadModal from './DuplicateUploadModal';
import Modal from './Modal';
import { PixivSettingsDialog } from './ExternalSourcesSettings';

const stages = { uploading: '正在下载', extracting: '正在解包', verifying: '正在校验与检测重复',
  awaiting_confirmation: '发现重复，等待确认', thumbnailing: '正在生成预览', extracted: '处理完成',
  generated: '处理完成', generating: '正在生成图包', failed: '处理失败' };

export default function UploadTask({ packId, onDone }: { packId: string; onDone: () => void }) {
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [settings, setSettings] = useState(false);
  const acting = useRef(false);
  const removed = useRef(false);
  const finish = () => { forgetUploadTask(); onDone(); };
  useEffect(() => {
    rememberUploadTask(packId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await get<Task>(`/packs/${packId}/upload-task`, controller.signal);
        if (controller.signal.aborted || removed.current) return;
        if (!acting.current) setTask(result);
        clearPacksCache();
        if (['extracted', 'generated', 'failed'].includes(result.pack.status) && !acting.current) return;
      } catch (err) {
        if (controller.signal.aborted || removed.current) return;
        if (!acting.current) setError(`无法更新处理状态：${err instanceof Error ? err.message : String(err)}`);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [packId, revision]);
  const act = async (action: () => Promise<void>) => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { acting.current = false; setBusy(false); setRevision(value => value + 1); }
  };
  const remove = async (target?: string) => {
    await del(`/packs/${packId}/upload-task`);
    removed.current = true;
    clearPacksCache(); finish();
    if (target) navigate(`/packs/${target}`);
  };
  const pack = task?.pack;
  const done = Boolean(pack && ['extracted', 'generated'].includes(pack.status));
  const failed = pack?.status === 'failed';
  const duplicate = pack?.status === 'awaiting_confirmation';
  const activeProgress = task?.progress && ['pending', 'running'].includes(task.progress.status) ? task.progress : null;
  const progress = pack?.status === 'verifying' ? pack.verification?.percentage : activeProgress?.total ? activeProgress.percentage : undefined;
  return <section className="bg-gray-900 rounded-2xl border border-gray-800 p-4">
    <h3 className="text-lg font-medium text-white mb-4 break-words">{pack?.name ?? '正在读取任务…'}</h3>
    <UploadTaskStatus stage={busy && confirmDelete ? '正在取消并清理文件…' : pack?.status === 'uploading' && pack.originalFormat !== 'pixiv' ? '等待上传完成' : pack ? stages[pack.status] : '正在读取任务'}
      done={done} paused={duplicate} error={error || (failed ? pack.errorMessage || '处理失败，请重试或删除后重新上传' : null)} progress={progress}
      detail={done ? `${pack!.imageCount} 张图片 · ${pack!.videoCount} 个视频，可以预览` : failed && !task?.retryable ? '请删除此任务，检查源文件或压缩包密码后重新上传。' : activeProgress?.total ? `${activeProgress.completed} / ${activeProgress.total} 个文件` : undefined}>
      {failed && task?.retryable && <button disabled={busy} className={taskActionClass} onClick={() => void act(async () => { await post(`/packs/${packId}/upload-task/retry`); })}>重试</button>}
      {pack?.originalFormat === 'pixiv' && (failed || error) && <button disabled={busy} className={taskActionClass} onClick={() => setSettings(true)}>配置 Pixiv 登录</button>}
      {duplicate && !task?.matches.length && <button disabled={busy} className={taskActionClass} onClick={() => void act(async () => { await post(`/packs/${packId}/upload-task/continue`); })}>继续处理</button>}
      {done ? <>
        <button className={taskActionClass} onClick={() => { finish(); navigate(`/packs/${packId}`); }}>查看图包</button>
        <button className={taskActionClass} onClick={finish}>继续上传</button>
      </> : <button disabled={busy} className={`${taskActionClass} text-red-300`} onClick={() => setConfirmDelete(true)}>{failed ? '删除任务' : '取消并删除'}</button>}
      {error && <><button disabled={busy} className={taskActionClass} onClick={() => { setError(''); setRevision(value => value + 1); }}>刷新状态</button><button disabled={busy} className={taskActionClass} onClick={finish}>返回上传</button></>}
    </UploadTaskStatus>
    <DuplicateUploadModal matches={duplicate ? task?.matches ?? [] : []} busy={busy} error={error || null}
      onContinue={() => void act(async () => { await post(`/packs/${packId}/upload-task/continue`); })}
      onCancel={() => void act(() => remove())} onSelect={id => void act(() => remove(id))} />
    {confirmDelete && <Modal visible onClose={() => { if (!busy) setConfirmDelete(false); }}>
      <div role="dialog" aria-modal="true" aria-label="删除上传任务" className="p-5">
        <h3 className="font-medium text-white mb-2">{failed ? '删除失败任务' : '取消并删除任务'}</h3>
        <p className="text-sm text-gray-400 mb-4">将删除本次任务和已保存的文件。已创建的标签会保留。</p>
        {busy && <p role="status" className="text-sm text-gray-400 mb-4">正在停止任务并清理；解包或预览生成需等待当前步骤结束。</p>}
        {error && <p role="alert" className="text-sm text-red-300 mb-4">{error}</p>}
        <div className="flex gap-2"><button disabled={busy} className={taskActionClass} onClick={() => setConfirmDelete(false)}>保留任务</button>
          <button disabled={busy} className={`${taskActionClass} text-red-300`} onClick={() => void act(() => remove())}>{busy ? '正在删除…' : '确认删除'}</button></div>
      </div>
    </Modal>}
    {settings && <PixivSettingsDialog onClose={() => setSettings(false)} />}
  </section>;
}
