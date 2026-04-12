import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePacks } from '../hooks/usePacks';
import { formatBytes, statusLabels, statusColors } from '../lib/utils';
import { getHomeScrollY, saveHomeScrollY } from '../lib/homeScrollStore';
import { Trash2, Search, X, Image } from 'lucide-react';

function highlightText(text: string, keywords: string[]): React.ReactNode {
  if (keywords.length === 0) return text;
  const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  escaped.sort((a, b) => b.length - a.length);
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const result: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      result.push(text.slice(last, match.index));
    }
    result.push(
      <mark key={match.index} className="bg-yellow-300/40 text-yellow-200 rounded-sm">
        {match[0]}
      </mark>
    );
    last = regex.lastIndex;
  }
  if (last < text.length) {
    result.push(text.slice(last));
  }
  return result.length > 0 ? result : text;
}

export default function HomePage() {
  const navigate = useNavigate();
  const { packs, loading, error, deletePack } = usePacks();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const restoredRef = useRef(false);

  // Restore scroll position after content renders
  useEffect(() => {
    const saved = getHomeScrollY();
    if (!loading && !restoredRef.current) {
      restoredRef.current = true;
      if (saved > 0) {
        requestAnimationFrame(() => window.scrollTo(0, saved));
      }
    }
  }, [loading]);

  const keywords = useMemo(() => {
    return searchQuery.trim().split(/\s+/).filter(Boolean).map(k => k.toLowerCase());
  }, [searchQuery]);

  const filteredPacks = useMemo(() => {
    if (keywords.length === 0) return packs;
    return packs.filter(
      (p) =>
        keywords.some((k) => p.name.toLowerCase().includes(k)) ||
        p.tags.some((t) => keywords.some((k) => t.name.toLowerCase().includes(k)))
    );
  }, [packs, keywords]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定要删除「${name}」吗？\n\n删除后将同步清除文件系统中的源文件，此操作不可恢复。`)) return;
    setDeleting(id);
    try {
      await deletePack(id);
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20 text-red-400">
        <p>加载失败: {error}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 h-9">
        <h2 className="text-xl font-bold text-white">我的图包<span className="text-gray-500 font-normal text-base">（{filteredPacks.length}）</span></h2>
        <div className="w-52 shrink-0 flex justify-end items-center h-full">
          {searching ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索图包..."
                autoFocus
                className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:border-blue-500 outline-none"
              />
              <button
                onClick={() => { setSearching(false); setSearchQuery(''); }}
                className="p-1.5 text-gray-400 hover:text-white transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setSearching(true)}
              className="p-2 text-gray-400 hover:text-white transition-colors"
            >
              <Search size={20} />
            </button>
          )}
        </div>
      </div>

      {filteredPacks.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          {searchQuery.trim() ? (
            <>
              <p className="text-lg mb-2">未找到匹配的图包</p>
              <p className="text-sm">试试其他关键词</p>
            </>
          ) : (
            <>
              <p className="text-lg mb-2">还没有图包</p>
              <p className="text-sm">点击底部「上传」添加第一个图包</p>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {filteredPacks.map((pack) => (
            <div
              key={pack.id}
              className="relative group bg-gray-900 rounded-xl overflow-hidden border border-gray-800 hover:border-gray-700 transition-colors cursor-pointer"
              onClick={() => { saveHomeScrollY(); navigate(`/packs/${pack.id}`); }}
            >
              {/* Cover image */}
              <div className="aspect-[4/3] bg-gray-800">
                <img
                  src={`/api/packs/${pack.id}/cover`}
                  alt={pack.name}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
                {/* Image count badge */}
                {pack.imageCount > 0 && (
                  <div className="absolute top-2 left-2 flex items-center gap-1 bg-black/60 rounded-lg px-2 py-1">
                    <Image size={12} className="text-white" />
                    <span className="text-xs text-white font-medium">{pack.imageCount}</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-3">
                <h3 className="text-sm font-medium text-white truncate">{highlightText(pack.name, keywords)}</h3>
                <div className="flex flex-wrap gap-1 mt-1.5 min-h-[20px]">
                  {pack.tags.slice(0, 3).map((tag) => (
                    <span
                      key={tag.id}
                      className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded"
                    >
                      {highlightText(tag.name, keywords)}
                    </span>
                  ))}
                  {pack.tags.length > 3 && (
                    <span className="text-xs text-gray-500">+{pack.tags.length - 3}</span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className={`text-xs ${statusColors[pack.status]}`}>
                    {statusLabels[pack.status]}
                  </span>
                  <span className="text-xs text-gray-500">{formatBytes(pack.originalSize)}</span>
                </div>
              </div>

              {/* Delete button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(pack.id, pack.name);
                }}
                disabled={deleting === pack.id}
                className="absolute top-2 right-2 p-1.5 bg-black/60 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600/80"
              >
                <Trash2 size={14} className="text-white" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
