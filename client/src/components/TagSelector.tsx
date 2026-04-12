import { useState, useEffect, useMemo } from 'react';
import { fetchTags, createTag, type TagWithStats } from '../api/packs';
import { X, Plus } from 'lucide-react';
import BottomPanel from './BottomPanel';

type Tag = TagWithStats;

interface TagSelectorProps {
  visible?: boolean;
  selectedIds: string[];
  onConfirm: (ids: string[]) => void;
  onClose: () => void;
  onClosed?: () => void;
}

export default function TagSelector({ visible = true, selectedIds, onConfirm, onClose, onClosed }: TagSelectorProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string[]>([...selectedIds]);
  const changed = selected.length !== selectedIds.length || selected.some((id) => !selectedIds.includes(id));

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchTags();
        setTags(data);
      } catch (err) {
        console.error('Failed to load tags:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return tags;
    const q = query.trim().toLowerCase();
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, query]);

  const toggleTag = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleCreate = async () => {
    const name = newTagName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const tag = await createTag(name);
      setTags((prev) => [...prev, { ...tag, count: 0, covers: [] }]);
      setSelected((prev) => [...prev, tag.id]);
      setNewTagName('');
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建标签失败');
    } finally {
      setCreating(false);
    }
  };

  const handleConfirm = () => {
    onConfirm(selected);
  };

  return (
    <BottomPanel visible={visible} onClose={onClose} onClosed={onClosed}>
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between p-4 border-b border-gray-800">
        <h3 className="text-white font-medium">选择标签</h3>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-white transition-colors">
          <X size={20} />
        </button>
      </div>

      {/* Search */}
      <div className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标签..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm outline-none placeholder:text-gray-500 focus:border-blue-500"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="p-0.5 text-gray-500 hover:text-gray-300 transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Tag list — fixed height, internal scroll */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 && !query.trim() ? (
          <p className="text-center text-gray-500 text-sm py-8">还没有标签，在下方创建一个</p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-gray-500 text-sm py-8">未找到匹配的标签</p>
        ) : (
          <div className="space-y-1">
            {filtered.map((tag) => {
              const isSelected = selected.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleTag(tag.id)}
                  className="w-full relative flex items-center gap-3 px-3 py-2.5 rounded-lg overflow-hidden transition-colors text-left bg-gray-800 border border-transparent hover:bg-gray-750"
                >
                  {/* Background covers (right-aligned, square, no margin to row edge) */}
                  {tag.covers.length > 0 && (
                    <div className="absolute inset-0 flex justify-end pointer-events-none">
                      {tag.covers.slice(0, 8).map((cover, i) => (
                        <img
                          key={i}
                          src={cover}
                          alt=""
                          className="h-full aspect-square object-cover"
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {/* Gradient overlay — above covers */}
                  <div className="absolute inset-0 bg-gradient-to-r from-gray-800 via-gray-800/70 to-transparent pointer-events-none" />

                  {/* Selected highlight — topmost layer */}
                  {isSelected && (
                    <div className="absolute inset-0 bg-blue-600/20 border border-blue-500/40 rounded-lg pointer-events-none" />
                  )}

                  {/* Checkbox */}
                  <div
                    className={`relative w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? 'bg-blue-600 border-blue-600' : 'border-gray-600'
                    }`}
                  >
                    {isSelected && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>

                  {/* Name & count */}
                  <span className={`relative text-sm ${isSelected ? 'text-blue-300' : 'text-gray-300'}`}>
                    {tag.name}{' '}
                    <span className="text-gray-500">({tag.count})</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Create new tag */}
      <div className="shrink-0 px-4 pb-2 py-2">
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
            }}
            placeholder="新建标签..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 outline-none"
          />
          <button
            onClick={handleCreate}
            disabled={!newTagName.trim() || creating}
            className="flex items-center justify-center w-10 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex gap-3 p-4 border-t border-gray-800 bg-gray-900" style={{
        paddingBottom: 'calc(var(--keyboard-offset, 0px) + var(--spacing) * 4)',
      }}>
        <button
          onClick={onClose}
          className="flex-1 py-2.5 bg-gray-800 text-gray-300 font-medium rounded-xl hover:bg-gray-700 transition-colors"
        >
          取消
        </button>
        <button
          onClick={handleConfirm}
          disabled={!changed}
          className={`flex-1 py-2.5 font-medium rounded-xl transition-colors ${
            changed
              ? 'bg-blue-600 text-white hover:bg-blue-500'
              : 'bg-gray-800 text-gray-500 cursor-not-allowed'
          }`}
        >
          确认 ({selected.length})
        </button>
      </div>
    </BottomPanel>
  );
}
