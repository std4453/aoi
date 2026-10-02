import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, LoaderCircle, Tag as TagIcon } from 'lucide-react';
import { del, post } from '../api/client';
import { startPixivImport, fetchPixivImport, retryPixivImport, fetchPixivMetadata } from '../api/pixiv';
import { fetchTags } from '../api/packs';
import type { PixivImportRequest, PixivImportStatus, Tag } from '../../../shared/types';
import { PixivIcon } from './ImportSources';
import { clearPacksCache } from '../lib/homeStore';
import DuplicateUploadModal from './DuplicateUploadModal';
import TagSelector from './TagSelector';

export default function PixivImport({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const packId = params.get('pixiv');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [state, setState] = useState<PixivImportStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [metadataReady, setMetadataReady] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [knownTags, setKnownTags] = useState<Tag[]>([]);
  const nameEdited = useRef(false);
  const tagsEdited = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (packId) return;
    let cancelled = false;
    setMetadataReady(false); setMetadataError(''); setRecognizing(false);
    if (!nameEdited.current) setName('');
    if (!tagsEdited.current) setTagIds([]);
    if (!/^https:\/\/(www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/[1-9]\d*(?:[/?#].*)?$/.test(url.trim())) return;
    setRecognizing(true);
    const timer = setTimeout(() => {
      void fetchPixivMetadata(url.trim()).then(metadata => {
        if (cancelled || started.current) return;
        if (!nameEdited.current) setName(metadata.title);
        if (!tagsEdited.current) setTagIds(metadata.tags.map(tag => tag.id));
        setKnownTags(metadata.tags);
        setMetadataReady(true);
      }).catch(() => {
        if (!cancelled && !started.current) setMetadataError('暂未识别，可直接导入');
      }).finally(() => { if (!cancelled) setRecognizing(false); });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [url, packId]);

  useEffect(() => {
    if (!packId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await fetchPixivImport(packId);
        if (disposed) return;
        setState(result);
        setError('');
        clearPacksCache();
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : '无法获取导入进度');
      }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [packId]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : '导入失败'); }
    finally { setBusy(false); }
  };
  const start = () => act(async () => {
    started.current = true;
    const input: PixivImportRequest = { url: url.trim(), packName: name.trim() || undefined,
      tagIds: metadataReady || tagsEdited.current ? tagIds : undefined };
    let pack;
    try { pack = await startPixivImport(input); }
    catch (error) { started.current = false; throw error; }
    setState({ pack, progress: null, matches: [] });
    setParams({ pixiv: pack.id }, { replace: true });
  });
  const done = state && ['extracted', 'generated'].includes(state.pack.status);
  const failed = state?.pack.status === 'failed';
  const leave = () => { clearPacksCache(); setParams({}, { replace: true }); onBack(); };

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center gap-2 mb-4">
        <button onClick={leave} aria-label="返回上传方式" className="text-gray-400 p-1"><ArrowLeft size={18} /></button>
        <PixivIcon className="w-6 h-6" /><h3 className="font-medium text-white">Pixiv</h3>
      </div>
      {!packId ? (
        <form onSubmit={event => { event.preventDefault(); void start(); }} className="space-y-4">
          <label className="block text-sm text-gray-300">作品网址
            {recognizing && <span aria-hidden="true" className="ml-2 text-xs text-gray-500">识别中…</span>}
            <input type="url" required maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.pixiv.net/artworks/150150651" className="mt-2 w-full rounded-xl bg-gray-800 border border-gray-700 p-3 text-white text-sm" />
          </label>
          {metadataError && <p className="text-xs text-gray-500">{metadataError}</p>}
          <label className="block text-sm text-gray-300">图包名称
            <input maxLength={200} value={name} onChange={e => { nameEdited.current = true; setName(e.target.value); }} placeholder="默认使用作品标题" className="mt-2 w-full rounded-xl bg-gray-800 border border-gray-700 p-3 text-white text-sm" />
          </label>
          <button type="button" onClick={() => setTagsOpen(true)} className="w-full flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-left">
            <TagIcon size={16} className="text-gray-500 shrink-0" />
            {tagIds.length ? <span className="flex flex-wrap gap-1">{tagIds.map(id => <span key={id} className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-300">{knownTags.find(tag => tag.id === id)?.name ?? '标签'}</span>)}</span> : <span className="text-sm text-gray-500">选择标签</span>}
          </button>
          <button disabled={busy || !url.trim()} className="w-full rounded-xl bg-blue-600 hover:bg-blue-500 p-3 text-white disabled:opacity-50">{busy ? '正在创建任务…' : '开始导入'}</button>
        </form>
      ) : (
        <div className="space-y-4" aria-live="polite">
          <p className="text-white break-words">{state?.pack.name || '正在读取导入任务…'}</p>
          {!done && !failed && <div className="flex items-center gap-2 text-blue-400"><LoaderCircle size={18} className="animate-spin" />{
            state?.pack.status === 'awaiting_confirmation' ? '等待重复图包确认' : state?.pack.status === 'verifying' ? '正在校验图片…' : state?.pack.status === 'thumbnailing' ? '正在生成预览…' : `下载原图 ${state?.progress?.completed ?? 0} / ${state?.progress?.total || '…'}`
          }</div>}
          {state?.pack.status === 'uploading' && <progress className="w-full accent-blue-500" max={100} value={state.progress?.percentage ?? 0} />}
          {state?.pack.status === 'awaiting_confirmation' && state.matches.length === 0 && <button disabled={busy} className="text-blue-400" onClick={() => void act(async () => { await post(`/packs/${packId}/folder-continue`); })}>继续导入</button>}
          {failed && <p className="text-red-400 text-sm">{state.pack.errorMessage}</p>}
          {failed && <button disabled={busy} className="text-blue-400" onClick={() => void act(async () => {
            if (state.pack.verification?.status === 'failed') await post(`/packs/${packId}/retry-verification`);
            else await retryPixivImport(packId!);
          })}>重试</button>}
          {done && <p className="text-green-400">导入完成 · {state.pack.imageCount} 个作品文件</p>}
          <button className="w-full rounded-xl bg-blue-600 p-3 text-white" onClick={() => navigate(`/packs/${packId}`)}>查看图包</button>
        </div>
      )}
      {error && <p role="alert" className="mt-4 text-sm text-red-400 break-words">{error}</p>}
      {tagsOpen && <TagSelector visible selectedIds={tagIds} onConfirm={ids => {
        tagsEdited.current = true; setTagIds(ids); setTagsOpen(false);
        void fetchTags().then(setKnownTags).catch(() => {});
      }} onClose={() => setTagsOpen(false)} onClosed={() => setTagsOpen(false)} />}
      <DuplicateUploadModal matches={state?.pack.status === 'awaiting_confirmation' ? state.matches : []} busy={busy} error={error || null}
        onContinue={() => void act(async () => { await post(`/packs/${packId}/folder-continue`); })}
        onCancel={() => void act(async () => { await del(`/packs/${packId}/cancel-upload`); leave(); })}
        onSelect={id => void act(async () => { await del(`/packs/${packId}/cancel-upload`); clearPacksCache(); navigate(`/packs/${id}`); })} />
    </section>
  );
}
