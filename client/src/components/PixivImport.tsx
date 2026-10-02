import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Tag as TagIcon } from 'lucide-react';
import { startPixivImport, fetchPixivMetadata } from '../api/pixiv';
import { fetchTags } from '../api/packs';
import type { PixivImportRequest, Tag } from '../../../shared/types';
import { PixivIcon } from './ImportSources';
import { clearPacksCache } from '../lib/homeStore';
import UploadTask from './UploadTask';
import { PixivSettingsDialog } from './ExternalSourcesSettings';
import TagSelector from './TagSelector';

export default function PixivImport({ onBack }: { onBack: () => void }) {
  const [params, setParams] = useSearchParams();
  const packId = params.get('pixiv');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [settings, setSettings] = useState(false);
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
      }).catch(error => {
        if (!cancelled && !started.current) setMetadataError(error instanceof Error ? error.message : '暂未识别，可直接导入');
      }).finally(() => { if (!cancelled) setRecognizing(false); });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [url, packId]);

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
    setParams({ pixiv: pack.id }, { replace: true });
  });
  const leave = () => { clearPacksCache(); setParams({}, { replace: true }); onBack(); };

  if (packId) return <UploadTask key={packId} packId={packId} onDone={leave} />;

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center gap-2 mb-4">
        <button onClick={leave} aria-label="返回上传方式" className="text-gray-400 p-1"><ArrowLeft size={18} /></button>
        <PixivIcon className="w-6 h-6" /><h3 className="font-medium text-white">Pixiv</h3>
      </div>
        <form onSubmit={event => { event.preventDefault(); void start(); }} className="space-y-4">
          <label className="block text-sm text-gray-300">作品网址
            {recognizing && <span aria-hidden="true" className="ml-2 text-xs text-gray-500">识别中…</span>}
            <input type="url" required maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.pixiv.net/artworks/150150651" className="mt-2 w-full rounded-xl bg-gray-800 border border-gray-700 p-3 text-white text-sm" />
          </label>
          {metadataError && <div role="alert" className="rounded-xl border border-amber-800 bg-amber-900/20 p-3 text-sm text-amber-200"><p>{metadataError}</p><button type="button" className="mt-2 underline" onClick={() => setSettings(true)}>配置 Pixiv 登录</button></div>}
          <label className="block text-sm text-gray-300">图包名称
            <input maxLength={200} value={name} onChange={e => { nameEdited.current = true; setName(e.target.value); }} placeholder="默认使用作品标题" className="mt-2 w-full rounded-xl bg-gray-800 border border-gray-700 p-3 text-white text-sm" />
          </label>
          <button type="button" onClick={() => setTagsOpen(true)} className="w-full flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-left">
            <TagIcon size={16} className="text-gray-500 shrink-0" />
            {tagIds.length ? <span className="flex flex-wrap gap-1">{tagIds.map(id => <span key={id} className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-300">{knownTags.find(tag => tag.id === id)?.name ?? '标签'}</span>)}</span> : <span className="text-sm text-gray-500">选择标签</span>}
          </button>
          <button disabled={busy || !url.trim()} className="w-full rounded-xl bg-blue-600 hover:bg-blue-500 p-3 text-white disabled:opacity-50">{busy ? '正在创建任务…' : '开始导入'}</button>
        </form>
      {error && <p role="alert" className="mt-4 text-sm text-red-400 break-words">{error}</p>}
      {tagsOpen && <TagSelector visible selectedIds={tagIds} onConfirm={ids => {
        tagsEdited.current = true; setTagIds(ids); setTagsOpen(false);
        void fetchTags().then(setKnownTags).catch(() => {});
      }} onClose={() => setTagsOpen(false)} onClosed={() => setTagsOpen(false)} />}
      {settings && <PixivSettingsDialog onClose={() => setSettings(false)} />}
    </section>
  );
}
