import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, ArrowLeft, LoaderCircle } from 'lucide-react';
import { del, post } from '../api/client';
import { startPixivImport, fetchPixivImport, retryPixivImport } from '../api/pixiv';
import type { PixivImportRequest, PixivImportStatus } from '../../../shared/types';
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
    const input: PixivImportRequest = { url: url.trim(), packName: name.trim() || undefined, tagIds };
    const pack = await startPixivImport(input);
    setState({ pack, progress: null, matches: [] });
    setParams({ pixiv: pack.id }, { replace: true });
  });
  const done = state && ['extracted', 'generated'].includes(state.pack.status);
  const failed = state?.pack.status === 'failed';
  const leave = () => { clearPacksCache(); setParams({}, { replace: true }); onBack(); };

  return (
    <section className="rounded-2xl border border-gray-700 bg-gray-900 p-6">
      <button onClick={leave} className="text-gray-400 text-sm flex items-center gap-2 mb-5"><ArrowLeft size={16} />返回上传方式</button>
      <div className="flex items-center gap-3 mb-2"><Download className="text-blue-400" /><h3 className="text-lg font-semibold text-white">从 Pixiv 导入</h3></div>
      <p className="text-sm text-gray-400 mb-5">粘贴作品网址，由服务器下载全部原图并保存为本地图包。支持插画、漫画。</p>
      {!packId ? (
        <form onSubmit={event => { event.preventDefault(); void start(); }} className="space-y-4">
          <label className="block text-sm text-gray-300">作品网址
            <input type="url" required maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.pixiv.net/artworks/150150651" className="mt-2 w-full rounded-xl bg-gray-800 border border-gray-700 p-3 text-white text-sm" />
          </label>
          <label className="block text-sm text-gray-300">图包名称（可选）
            <input maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="默认使用作品标题和作者" className="mt-2 w-full rounded-xl bg-gray-800 border border-gray-700 p-3 text-white text-sm" />
          </label>
          <button type="button" onClick={() => setTagsOpen(true)} className="text-sm text-gray-300">选择标签{tagIds.length ? `（${tagIds.length}）` : ''}</button>
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
          {!done && !failed && <p className="text-xs text-gray-400">离开页面后服务器仍会继续导入，可从图包详情返回查看进度。</p>}
          {failed && <p className="text-red-400 text-sm">{state.pack.errorMessage}</p>}
          {failed && <button disabled={busy} className="text-blue-400" onClick={() => void act(async () => {
            if (state.pack.verification?.status === 'failed') await post(`/packs/${packId}/retry-verification`);
            else await retryPixivImport(packId!);
          })}>重试</button>}
          {done && <p className="text-green-400">导入完成，已保存 {state.pack.imageCount} 张原图。</p>}
          <button className="w-full rounded-xl bg-blue-600 p-3 text-white" onClick={() => navigate(`/packs/${packId}`)}>查看图包</button>
        </div>
      )}
      {error && <p role="alert" className="mt-4 text-sm text-red-400 break-words">{error}</p>}
      {tagsOpen && <TagSelector visible selectedIds={tagIds} onConfirm={ids => { setTagIds(ids); setTagsOpen(false); }} onClose={() => setTagsOpen(false)} onClosed={() => setTagsOpen(false)} />}
      <DuplicateUploadModal matches={state?.pack.status === 'awaiting_confirmation' ? state.matches : []} busy={busy} error={error || null}
        onContinue={() => void act(async () => { await post(`/packs/${packId}/folder-continue`); })}
        onCancel={() => void act(async () => { await del(`/packs/${packId}/cancel-upload`); leave(); })}
        onSelect={id => void act(async () => { await del(`/packs/${packId}/cancel-upload`); clearPacksCache(); navigate(`/packs/${id}`); })} />
    </section>
  );
}
