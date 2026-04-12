import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchTags, fetchTagPacks, renameTag, removeTag, type TagWithStats } from '../api/packs';
import { formatBytes, statusLabels, statusColors } from '../lib/utils';
import type { Pack } from '../../../shared/types.js';
import { ArrowLeft, Trash2, Pencil, X, Tag, Check } from 'lucide-react';
import Modal from '../components/Modal';

type TagItem = TagWithStats;

export default function TagManagerPage() {
  const navigate = useNavigate();
  const [tags, setTags] = useState<TagItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<TagItem | null>(null);
  const [tagModalPhase, setTagModalPhase] = useState<null | 'open' | 'closing'>(null);
  const [tagPacks, setTagPacks] = useState<Pack[]>([]);
  const [packsLoading, setPacksLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const loadTags = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchTags();
      setTags(data);
    } catch (err) {
      console.error('Failed to load tags:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const filteredTags = useMemo(() => {
    if (!query.trim()) return tags;
    const q = query.trim().toLowerCase();
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, query]);

  const openTag = async (tag: TagItem) => {
    setActiveTag(tag);
    setTagModalPhase('open');
    setRenaming(false);
    setRenameValue(tag.name);
    setPacksLoading(true);
    setTagPacks([]);
    try {
      const packs = await fetchTagPacks(tag.id);
      setTagPacks(packs);
    } catch (err) {
      console.error('Failed to load tag packs:', err);
    } finally {
      setPacksLoading(false);
    }
  };

  const closeTagModal = () => {
    setTagModalPhase('closing');
  };

  const handleRename = async () => {
    if (!activeTag || !renameValue.trim()) return;
    try {
      const updated = await renameTag(activeTag.id, renameValue.trim());
      setTags((prev) => prev.map((t) => (t.id === activeTag.id ? { ...t, name: updated.name } : t)));
      setActiveTag((prev) => prev ? { ...prev, name: updated.name } : null);
      setRenaming(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : '重命名失败');
    }
  };

  const handleDelete = async () => {
    if (!activeTag) return;
    if (!confirm(`确定要删除标签「${activeTag.name}」吗？\n\n已有图包将不再关联此标签，图包本身不受影响。`)) return;
    try {
      await removeTag(activeTag.id);
      setTags((prev) => prev.filter((t) => t.id !== activeTag.id));
      closeTagModal();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败');
    }
  };

  return (
    <div>
      <div className="h-9 flex items-center mb-4">
        <button
          onClick={() => navigate('/settings')}
          className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={18} />
          <span className="text-sm">返回</span>
        </button>
      </div>

      <h2 className="text-xl font-bold text-white mb-4">标签管理</h2>

      {/* Search */}
      <div className="mb-3">
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

      {/* Tag list */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filteredTags.length === 0 ? (
        <p className="text-center text-gray-500 text-sm py-8">
          {query.trim() ? '未找到匹配的标签' : '还没有标签'}
        </p>
      ) : (
        <div className="space-y-1">
          {filteredTags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => openTag(tag)}
              className="relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg overflow-hidden bg-gray-800 hover:bg-gray-750 transition-colors text-left"
            >
              {/* Background covers */}
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
              {/* Gradient */}
              <div className="absolute inset-0 bg-gradient-to-r from-gray-800 via-gray-800/70 to-transparent pointer-events-none" />

              <span className="relative text-sm text-gray-300 flex-1 min-w-0 truncate">
                {tag.name}{' '}
                <span className="text-gray-500">({tag.count})</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Tag detail modal */}
      {tagModalPhase && activeTag && (
        <Modal
          visible={tagModalPhase === 'open'}
          onClose={closeTagModal}
          onClosed={() => { setTagModalPhase(null); setActiveTag(null); }}
          className="flex flex-col"
        >
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between p-4 border-b border-gray-800">
              {renaming ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename();
                      if (e.key === 'Escape') setRenaming(false);
                    }}
                    autoFocus
                    className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-sm outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleRename}
                    className="p-1.5 text-blue-400 hover:text-blue-300 transition-colors shrink-0"
                  >
                    <Check size={18} />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-baseline gap-2 min-w-0">
                    <Tag size={16} className="text-gray-400 shrink-0 self-center" />
                    <h3 className="text-white font-medium truncate">{activeTag.name}</h3>
                    <span className="text-xs text-gray-500 shrink-0">{activeTag.count}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setRenaming(true)}
                      className="p-2 text-gray-400 hover:text-white transition-colors"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={handleDelete}
                      className="p-2 text-gray-400 hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                    <button
                      onClick={closeTagModal}
                      className="p-2 text-gray-400 hover:text-white transition-colors"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Packs list */}
            <div className="overflow-y-auto p-4" style={{ height: '448px' }}>
              {packsLoading ? (
                <div className="flex items-center justify-center h-[416px]">
                  <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : tagPacks.length === 0 ? (
                <p className="flex items-center justify-center h-[416px] text-gray-500 text-sm">没有关联的图包</p>
              ) : (
                <div className="space-y-2">
                  {tagPacks.map((pack) => (
                    <button
                      key={pack.id}
                      onClick={() => {
                        closeTagModal();
                        setTimeout(() => navigate(`/packs/${pack.id}`), 150);
                      }}
                      className="w-full flex items-center gap-3 bg-gray-800 rounded-lg p-2 text-left hover:bg-gray-750 transition-colors"
                    >
                      <img
                        src={`/api/packs/${pack.id}/cover`}
                        alt={pack.name}
                        className="w-12 h-9 rounded object-cover shrink-0"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{pack.name}</p>
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <span>{pack.imageCount} 张图片</span>
                          <span className={statusColors[pack.status]}>
                            {statusLabels[pack.status]}
                          </span>
                          <span>{formatBytes(pack.originalSize)}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
        </Modal>
      )}
    </div>
  );
}
