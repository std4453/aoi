import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePacks } from '../hooks/usePacks';
import { formatBytes, statusLabels, statusColors } from '../lib/utils';
import { getHomeScrollY, saveHomeScrollY, saveLastHomeSearch, clearHomeScrollY } from '../lib/homeScrollStore';
import { Trash2, Search, X, Image, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

function renderPageButtons(currentPage: number, totalPages: number, goToPage: (p: number) => void) {
  const buttons: React.ReactNode[] = [];
  const pages = new Set<number>([1, currentPage, totalPages]);
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    pages.add(i);
  }
  const sorted = Array.from(pages).sort((a, b) => a - b);

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      buttons.push(
        <span key={`ellipsis-${p}`} className="text-gray-500 text-sm px-0.5">...</span>
      );
    }
    buttons.push(
      <button
        key={p}
        onClick={() => goToPage(p)}
        className={`min-w-[2rem] h-8 rounded text-sm transition-colors ${
          p === currentPage
            ? 'bg-blue-600 text-white'
            : 'text-gray-300 hover:text-white hover:bg-gray-800'
        }`}
      >
        {p}
      </button>
    );
  }
  return buttons;
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="bg-gray-900 rounded-xl overflow-hidden border border-gray-800 animate-pulse">
          <div className="aspect-[4/3] bg-gray-800" />
          <div className="p-3">
            <div className="h-[1.125rem] bg-gray-800 rounded w-3/4" />
            <div className="flex gap-1 mt-1.5 min-h-[20px]">
              <div className="h-[18px] bg-gray-800 rounded w-10" />
              <div className="h-[18px] bg-gray-800 rounded w-10" />
              <div className="h-[18px] bg-gray-800 rounded w-10" />
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <div className="h-[1.125rem] bg-gray-800 rounded w-8" />
              <div className="h-[1.125rem] bg-gray-800 rounded w-12" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const { packs, total, page, pageSize, loading, error, deletePack, goToPage, setSearchQuery, search, hardReset } = usePacks();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(search);
  const [searching, setSearching] = useState(!!search);
  const [debouncing, setDebouncing] = useState(false);
  const restoredRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isFirstRender = useRef(true);
  const pendingScrollTopRef = useRef(false);

  const totalPages = Math.ceil(total / pageSize);

  // Sync inputValue when search changes from URL (e.g. browser back/forward)
  useEffect(() => {
    setInputValue(search);
    if (search) setSearching(true);
  }, [search]);

  // Debounced search — only update URL after debounce
  const handleSearchChange = useCallback((value: string) => {
    setInputValue(value);
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setSearchQuery('');
      setDebouncing(false);
      return;
    }
    setDebouncing(true);
    debounceRef.current = setTimeout(() => {
      setSearchQuery(value);
      setDebouncing(false);
    }, 300);
  }, [setSearchQuery]);

  const handleSearchSubmit = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    setSearchQuery(inputValue);
    setDebouncing(false);
  }, [inputValue, setSearchQuery]);

  const handleClearSearch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    if (inputValue.trim()) {
      setInputValue('');
      setSearchQuery('');
    } else {
      setSearching(false);
    }
    setDebouncing(false);
  }, [inputValue, setSearchQuery]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current !== undefined) clearTimeout(debounceRef.current); };
  }, []);

  // Save current URL params for tab restoration
  useEffect(() => {
    saveLastHomeSearch(window.location.search);
  }, [page, search]);

  // Handle hard reset from tab double-click / click-at-top
  useEffect(() => {
    const handler = () => {
      hardReset();
      clearHomeScrollY();
      window.scrollTo(0, 0);
    };
    window.addEventListener('home:hard-reset', handler);
    return () => window.removeEventListener('home:hard-reset', handler);
  }, [hardReset]);

  const handlePageChange = useCallback((p: number) => {
    goToPage(p);
    pendingScrollTopRef.current = true;
  }, [goToPage]);

  // After page change data loads, smooth scroll to top
  useEffect(() => {
    if (!loading && pendingScrollTopRef.current) {
      pendingScrollTopRef.current = false;
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }, [loading]);

  // Restore scroll position after content renders
  useEffect(() => {
    // Skip on first render while data is loading
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (!loading) {
        restoredRef.current = true;
        const saved = getHomeScrollY();
        if (saved > 0) requestAnimationFrame(() => window.scrollTo(0, saved));
      }
      return;
    }
    if (!loading && !restoredRef.current) {
      restoredRef.current = true;
      const saved = getHomeScrollY();
      if (saved > 0) requestAnimationFrame(() => window.scrollTo(0, saved));
    }
  }, [loading]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定要删除「${name}」吗？\n\n删除后将同步清除文件系统中的源文件，此操作不可恢复。`)) return;
    setDeleting(id);
    try {
      await deletePack(id);
    } finally {
      setDeleting(null);
    }
  };

  const isInitialLoad = loading && packs.length === 0;
  const stale = packs.length > 0 && (loading || debouncing);

  // Search box — always rendered regardless of loading state
  const searchBox = searching ? (
    <div className="flex items-center gap-1.5">
      <div className="relative flex-1 min-w-0">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearchSubmit(); }}
          placeholder="搜索图包..."
          autoFocus
          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-3 pr-8 py-1.5 text-white text-sm focus:border-blue-500 outline-none"
        />
        {loading && (
          <Loader2 size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 animate-spin" />
        )}
      </div>
      <button
        onClick={handleClearSearch}
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
  );

  if (error && packs.length === 0) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4 h-9">
          <h2 className="text-xl font-bold text-white">我的图包</h2>
          <div className="w-52 shrink-0 flex justify-end items-center h-full">{searchBox}</div>
        </div>
        <div className="text-center py-20 text-red-400">
          <p>加载失败: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-7rem)]">
      <div className="flex items-center justify-between mb-4 h-9">
        <h2 className="text-xl font-bold text-white">我的图包<span className="text-gray-500 font-normal text-base">（{total}）</span></h2>
        <div className="w-52 shrink-0 flex justify-end items-center h-full">
          {searchBox}
        </div>
      </div>

      {isInitialLoad ? (
        <SkeletonGrid />
      ) : packs.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          {inputValue.trim() ? (
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
        <div className={`transition-opacity duration-150 ${stale ? 'opacity-50' : ''}`}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {packs.map((pack) => (
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
                  <h3 className="text-sm font-medium text-white truncate">{pack.name}</h3>
                  <div className="flex flex-wrap gap-1 mt-1.5 min-h-[20px]">
                    {pack.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag.id}
                        className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded"
                      >
                        {tag.name}
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

          {/* Pagination - sticky bottom */}
          {totalPages > 1 && (
            <div className="sticky bottom-[4.25rem] h-11 pb-1 pt-1 mt-1 flex items-center justify-center bg-gradient-to-t from-gray-950/60 via-gray-950/30 to-transparent">
              <div className="flex items-center gap-0.5 bg-gray-950/50 rounded">
                <button
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page <= 1}
                  className="p-2 text-gray-300 hover:text-white disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                {renderPageButtons(page, totalPages, handlePageChange)}
                <button
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page >= totalPages}
                  className="p-2 text-gray-300 hover:text-white disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
