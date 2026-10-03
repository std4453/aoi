import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PackThumbnail } from '../../../shared/types';
import { fetchThumbnails } from '../api/packs';
import { resourceUrl } from '../lib/connection';
import { ActionRow, Button } from './Button';

export default function PackProcessingResult({ packId, onDone }: {
  packId: string | null;
  onDone: () => void | Promise<unknown>;
}) {
  const navigate = useNavigate();
  const [thumbnails, setThumbnails] = useState<PackThumbnail[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setThumbnails([]);
    if (packId) {
      void fetchThumbnails(packId).then(items => { if (active) setThumbnails(items.slice(0, 6)); }).catch(() => {});
    }
    return () => { active = false; };
  }, [packId]);
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
  return <div className="flex flex-col gap-3" aria-label="图包处理结果">
    {thumbnails.length > 0 && <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="图包预览">
      {thumbnails.map(item => <button key={item.name} type="button" disabled={busy} onClick={() => { void finish(true); }}
        className="relative aspect-square overflow-hidden rounded-lg bg-gray-800" aria-label={`预览 ${item.name}`}>
        <img src={resourceUrl(item.thumbUrl)} crossOrigin="anonymous" alt={item.name} className="h-full w-full object-cover" />
        {item.mediaType === 'ugoira' && <span className="absolute bottom-0 right-0 bg-black/70 px-1 text-xs text-white">动图</span>}
      </button>)}
    </div>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <ActionRow>
      {packId && <Button variant="secondary" disabled={busy} onClick={() => { void finish(true); }}>查看图包</Button>}
      <Button variant="primary" disabled={busy} onClick={() => { void finish(); }}>完成</Button>
    </ActionRow>
  </div>;
}
