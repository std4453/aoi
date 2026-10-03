import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Tag } from 'lucide-react';
import { fetchTags, type TagWithStats } from '../api/packs';
import TagSelector from './TagSelector';

/** Controlled field; one catalog is shared by its selected labels and bottom-sheet selector. */
export default function TagSelectField({ value, onChange, disabled = false }: {
  value: string[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const [selector, setSelector] = useState<null | 'open' | 'closing'>(null);
  const [tags, setTags] = useState<TagWithStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const catalog = useRef<TagWithStats[] | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const selectedKey = value.join(',');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = () => {
    if (pending.current) return pending.current;
    setLoading(true); setError('');
    pending.current = fetchTags().then(items => {
      // A tag may be created while the initial catalog request is still in flight.
      const merged = [...items, ...(catalog.current ?? []).filter(tag => !items.some(item => item.id === tag.id))];
      catalog.current = merged;
      if (mounted.current) setTags(merged);
    }).catch(() => { if (mounted.current) setError('标签名称暂时无法加载'); }).finally(() => {
      pending.current = null;
      if (mounted.current) setLoading(false);
    });
    return pending.current;
  };
  useEffect(() => {
    if (selectedKey && selectedKey.split(',').some(id => !catalog.current?.some(tag => tag.id === id))) void load();
  }, [selectedKey]);
  return <div>
    <button type="button" onClick={() => { if (!catalog.current || error) void load(); setSelector('open'); }} disabled={disabled}
      aria-expanded={selector === 'open'} aria-label={value.length ? `选择标签，已选择 ${value.length} 个` : '选择标签'}
      className="flex w-full items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-700 disabled:opacity-50">
      <Tag size={16} className="shrink-0" /><span className="flex min-w-0 flex-1 flex-wrap gap-1 text-left">{value.length
        ? value.map(id => <span key={id} className="max-w-full truncate rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300">{tags.find(tag => tag.id === id)?.name ?? '…'}</span>)
        : '选择标签'}</span><ChevronDown size={14} className="shrink-0" />
    </button>
    {error && <p role="status" className="mt-2 text-xs text-amber-400">{error}</p>}
    {selector && createPortal(<TagSelector visible={selector === 'open'} selectedIds={value}
      catalog={{ tags, loading, onCreated: tag => {
        const items = [...(catalog.current ?? []).filter(item => item.id !== tag.id), tag];
        catalog.current = items; setTags(items);
      } }}
      onConfirm={ids => { onChange(ids); setSelector('closing'); }}
      onClose={() => setSelector('closing')} onClosed={() => setSelector(null)} />, document.body)}
  </div>;
}
