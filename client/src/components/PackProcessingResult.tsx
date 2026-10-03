import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ImageOff } from 'lucide-react';
import type { PackThumbnail } from '../../../shared/types';
import { fetchThumbnails } from '../api/packs';
import { resourceUrl } from '../lib/connection';
import { ActionRow, Button } from './Button';
import { TaskNotice, TaskTextAction } from './TaskFeedback';

function PreviewSkeleton() {
  return <span aria-hidden="true" className="absolute inset-0 rounded-lg bg-gray-800 motion-safe:animate-pulse" />;
}

function ResultThumbnail({ item, busy, onOpen }: { item: PackThumbnail; busy: boolean; onOpen: () => void }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  return <button type="button" disabled={busy} onClick={onOpen} aria-busy={status === 'loading'}
    className="relative aspect-square overflow-hidden rounded-lg bg-gray-800" aria-label={`预览 ${item.name}`}>
    {status === 'loading' && <PreviewSkeleton />}
    {status === 'failed' ? <span title="预览不可用" className="flex h-full items-center justify-center text-gray-500"><ImageOff size={18} aria-hidden="true" /><span className="sr-only">预览不可用</span></span>
      : <img src={resourceUrl(item.thumbUrl)} crossOrigin="anonymous" alt={item.name}
        onLoad={() => setStatus('ready')} onError={() => setStatus('failed')}
        className={`absolute inset-0 h-full w-full object-cover ${status === 'ready' ? 'opacity-100' : 'opacity-0'}`} />}
    {item.mediaType === 'ugoira' && status === 'ready' && <span className="absolute bottom-0 right-0 bg-black/70 px-1 text-xs text-white">动图</span>}
  </button>;
}

function ResultPreview({ packId, busy, onOpen }: { packId: string; busy: boolean; onOpen: () => void }) {
  const [preview, setPreview] = useState<{ status: 'loading' | 'ready' | 'failed'; items: PackThumbnail[] }>({ status: 'loading', items: [] });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchThumbnails(packId).then(items => {
      if (active) setPreview({ status: 'ready', items: items.slice(0, 6) });
    }).catch(() => { if (active) setPreview({ status: 'failed', items: [] }); });
    return () => { active = false; };
  }, [packId, revision]);
  if (preview.status === 'failed') return <TaskNotice tone="neutral">预览暂时无法加载。<TaskTextAction className="ml-2" onClick={() => {
    setPreview({ status: 'loading', items: [] }); setRevision(value => value + 1);
  }}>重试</TaskTextAction></TaskNotice>;
  if (preview.status === 'ready' && !preview.items.length) return <TaskNotice tone="neutral">此图包暂无可预览的图片。</TaskNotice>;
  return <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="图包预览" aria-busy={preview.status === 'loading'}>
    {preview.status === 'loading' ? <>
      <span role="status" className="sr-only">正在加载图包预览…</span>
      {Array.from({ length: 6 }, (_, index) => <div key={index} className="relative aspect-square"><PreviewSkeleton /></div>)}
    </> : preview.items.map(item => <ResultThumbnail key={`${item.name}:${item.thumbUrl}`} item={item} busy={busy} onOpen={onOpen} />)}
  </div>;
}

export default function PackProcessingResult({ packId, onDone }: {
  packId: string | null;
  onDone: () => void | Promise<unknown>;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const finish = async (openPack = false) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onDone();
      if (openPack && packId) navigate(`/packs/${packId}`);
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-2" aria-label="图包处理结果">
    {packId && <ResultPreview key={packId} packId={packId} busy={busy} onOpen={() => { void finish(true); }} />}
    {error && <TaskNotice role="alert" tone="error">{error}</TaskNotice>}
    <ActionRow>
      {packId && <Button variant="secondary" disabled={busy} onClick={() => { void finish(true); }}>查看图包</Button>}
      <Button variant="primary" disabled={busy} onClick={() => { void finish(); }}>完成</Button>
    </ActionRow>
  </div>;
}
