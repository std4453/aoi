import { resourceUrl } from '../lib/connection';
import { useEffect, useState } from 'react';
import type { DuplicatePack } from '../../../shared/types.js';
import { fetchThumbnails } from '../api/packs';
import { statusLabels } from '../lib/utils';
import Modal from './Modal';

function DuplicateCard({ pack, disabled, onSelect }: { pack: DuplicatePack; disabled: boolean; onSelect: () => void }) {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    fetchThumbnails(pack.id).then(items => {
      if (active) setThumbnails(items.slice(0, 4).map(item => item.thumbUrl));
    }).catch(() => {}).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pack.id]);
  return (
    <button type="button" disabled={disabled} onClick={onSelect}
      className="w-full rounded-xl border border-gray-700 p-3 text-left hover:border-blue-500 hover:bg-gray-800 focus-visible:outline-blue-400 disabled:opacity-50">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="font-medium text-white break-all">{pack.name}</span>
        <span className="text-xs text-gray-400 shrink-0 pt-1">{statusLabels[pack.status]}</span>
      </div>
      {thumbnails.length > 0 ? (
        <div className="grid grid-cols-4 gap-2">
          {thumbnails.map(url => <img key={url} src={resourceUrl(url)} crossOrigin="anonymous" alt="图包缩略图" className="aspect-square w-full rounded-lg object-cover bg-gray-800"
            onError={() => setThumbnails(previous => previous.filter(item => item !== url))} />)}
        </div>
      ) : <div className="rounded-lg bg-gray-800 py-5 text-center text-sm text-gray-500">{loading ? '正在加载缩略图…' : '暂无缩略图'}</div>}
      <p className="mt-2 text-xs text-blue-400">查看此图包 →</p>
    </button>
  );
}

export default function DuplicateUploadModal({ matches, busy, error, onCancel, onContinue, onSelect }: {
  matches: DuplicatePack[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onContinue: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <Modal visible={matches.length > 0} onClose={() => {}} className="max-w-lg">
      <div role="dialog" aria-modal="true" aria-labelledby="duplicate-upload-title" aria-busy={busy} className="p-5">
        <h3 id="duplicate-upload-title" className="text-lg font-semibold text-white mb-4">此图包可能已被上传过：</h3>
        <div className="space-y-3 max-h-[55dvh] overflow-y-auto">
          {matches.map(pack => <DuplicateCard key={pack.id} pack={pack} disabled={busy} onSelect={() => onSelect(pack.id)} />)}
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="flex gap-3 mt-5">
          <button type="button" disabled={busy} onClick={onCancel} className="flex-1 py-3 rounded-xl bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-50">取消上传</button>
          <button type="button" disabled={busy} onClick={onContinue} className="flex-1 py-3 rounded-xl bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">{busy ? '处理中…' : '继续上传'}</button>
        </div>
      </div>
    </Modal>
  );
}
