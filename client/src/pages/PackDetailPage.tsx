import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchPack, fetchThumbnails, fetchFileTree, startProcessing, removePack, renamePack, updatePackTags } from '../api/packs';
import { usePresets } from '../hooks/usePresets';
import { useJobProgress } from '../hooks/useJobProgress';
import { formatBytes, statusLabels, statusColors } from '../lib/utils';
import type { Pack, CompressionOptions, FileSelection, FileTreeNode } from '../../../shared/types.js';
import { Download, Play, ArrowLeft, Loader2, Image, Video, HardDrive, Pencil, Trash2, Tag, FolderTree } from 'lucide-react';
import ImageViewer from '../components/ImageViewer';
import BlurhashPlaceholder, { blurhashToDataUrl } from '../components/BlurhashPlaceholder';
import TagSelector from '../components/TagSelector';
import FileTreePanel from '../components/FileTreePanel';
import Modal from '../components/Modal';

const DEFAULT_OPTIONS: CompressionOptions = {
  format: 'jpeg',
  quality: 80,
  keepVideos: true,
  scaleImages: true,
  maxDimension: 1920,
};

export default function PackDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pack, setPack] = useState<Pack | null>(null);
  const [thumbnails, setThumbnails] = useState<{ name: string; thumbUrl: string; imageUrl: string; blurhash: string | null; width: number | null; height: number | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [options, setOptions] = useState<CompressionOptions>(DEFAULT_OPTIONS);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;
  const viewerIndex = useMemo(() => {
    const param = searchParams.get('image');
    if (param === null) return null;
    const index = parseInt(param, 10);
    if (isNaN(index) || index < 0 || index >= thumbnails.length) return null;
    return index;
  }, [searchParams, thumbnails.length]);
  const handleViewerIndexChange = useCallback((index: number) => {
    setSearchParamsRef.current({ image: String(index) }, { replace: true });
  }, []);
  const [renaming, setRenaming] = useState<null | 'open' | 'closing'>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<null | 'open' | 'closing'>(null);
  const [deleting, setDeleting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTagSelector, setShowTagSelector] = useState<null | 'open' | 'closing'>(null);
  const [showFileTree, setShowFileTree] = useState<'view' | 'select' | null>(null);
  const [fileSelection, setFileSelection] = useState<FileSelection | null>(null);
  const [fileTreeExpandedPaths, setFileTreeExpandedPaths] = useState<Set<string> | null>(null);
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const blurhashCache = useRef(new Map<string, string>());

  const { presets, defaultPreset } = usePresets();
  const progress = useJobProgress(jobId);

  const loadPack = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [packData, thumbs, tree] = await Promise.all([
        fetchPack(id),
        fetchThumbnails(id).catch(() => []),
        fetchFileTree(id).catch(() => []),
      ]);
      setPack(packData);
      setThumbnails(thumbs);
      setFileTree(tree);
    } catch (err) {
      console.error('Failed to load pack:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Load pack metadata only (no thumbnails) — lightweight for polling
  const refreshPackStatus = useCallback(async () => {
    if (!id) return;
    try {
      const packData = await fetchPack(id);
      setPack(packData);
    } catch (err) {
      console.error('Failed to refresh pack status:', err);
    }
  }, [id]);

  // Load thumbnails only
  const loadThumbnails = useCallback(async () => {
    if (!id) return;
    try {
      const thumbs = await fetchThumbnails(id).catch(() => []);
      setThumbnails(thumbs);
    } catch (err) {
      console.error('Failed to load thumbnails:', err);
    }
  }, [id]);

  // Load file tree only
  const loadFileTree = useCallback(async () => {
    if (!id) return;
    try {
      const tree = await fetchFileTree(id).catch(() => []);
      setFileTree(tree);
    } catch (err) {
      console.error('Failed to load file tree:', err);
    }
  }, [id]);

  // Load thumbnails and file tree when thumbnailing finishes (must run BEFORE prevStatus update)
  const prevStatus = useRef(pack?.status);
  useEffect(() => {
    if (prevStatus.current === 'thumbnailing' && pack?.status === 'extracted') {
      loadThumbnails();
      loadFileTree();
    }
    prevStatus.current = pack?.status;
  }, [pack?.status, loadThumbnails, loadFileTree]);

  // Pre-compute blurhash data URLs in background for faster ImageViewer switching
  useEffect(() => {
    const cache = blurhashCache.current;
    for (const t of thumbnails) {
      if (t.blurhash && t.width && t.height && !cache.has(t.blurhash)) {
        blurhashToDataUrl(t.blurhash, t.width, t.height, cache);
      }
    }
  }, [thumbnails]);

  // Auto-refresh pack status while extracting/thumbnailing
  useEffect(() => {
    if (pack?.status !== 'extracting' && pack?.status !== 'thumbnailing') return;
    const timer = setInterval(refreshPackStatus, 1000);
    return () => clearInterval(timer);
  }, [pack?.status, refreshPackStatus]);

  // Initial load
  useEffect(() => {
    loadPack();
  }, [loadPack]);

  const images = useMemo(() => thumbnails.map((t) => ({
    name: t.name,
    thumbUrl: t.thumbUrl,
    fullUrl: t.imageUrl,
    blurhash: t.blurhash,
    width: t.width,
    height: t.height,
  })), [thumbnails]);

  // Refresh when generation job completes
  useEffect(() => {
    if (progress && progress.status === 'completed' && id) {
      refreshPackStatus();
      setJobId(null);
    }
  }, [progress?.status, id, refreshPackStatus]);

  // Apply default preset when available
  useEffect(() => {
    if (defaultPreset && !selectedPresetId) {
      setOptions(defaultPreset.options);
      setSelectedPresetId(defaultPreset.id);
    }
  }, [defaultPreset, selectedPresetId]);

  const handlePresetChange = (presetId: string) => {
    setSelectedPresetId(presetId);
    const preset = presets.find((p) => p.id === presetId);
    if (preset) {
      setOptions({ ...preset.options });
    }
  };

  const closeViewer = useCallback(() => window.history.back(), []);
  const openFileTreeFromViewer = useCallback(() => setShowFileTree('view'), []);

  const handleGenerate = async () => {
    if (!id) return;
    try {
      const result = await startProcessing(id, {
        presetId: selectedPresetId || undefined,
        options: selectedPresetId ? undefined : options,
        fileSelection: fileSelection ?? undefined,
      });
      setJobId(result.jobId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownload = () => {
    if (!id) return;
    window.open(`/api/packs/${id}/download`, '_blank');
  };

  const handleRename = () => {
    if (!pack) return;
    setRenameValue(pack.name);
    setRenaming('open');
  };

  const confirmRename = async () => {
    if (!id || !renameValue.trim()) return;
    try {
      const updated = await renamePack(id, renameValue.trim());
      setPack(updated);
    } catch (err) {
      alert(err instanceof Error ? err.message : '重命名失败');
    }
    setRenaming('closing');
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await removePack(id);
      navigate('/');
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败');
    }
    setDeleting(false);
    setDeleteConfirm('closing');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!pack) {
    return (
      <div className="text-center py-20 text-red-400">
        <p>图包不存在</p>
      </div>
    );
  }

  const isProcessing = progress && (progress.status === 'running');
  const isGenerated = pack.status === 'generated';
  const canGenerate = pack.status === 'extracted' || pack.status === 'generated';

  return (
    <div className={viewerIndex !== null ? 'select-none' : ''}>
      {/* Back button */}
      <div className="h-9 flex items-center mb-4">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={18} />
          <span className="text-sm">返回</span>
        </button>
      </div>

      {/* Pack header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-bold text-white leading-tight mb-2">{pack.name}</h2>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setShowTagSelector('open')}
              className="p-2 text-gray-400 hover:text-white transition-colors"
            >
              <Tag size={16} />
            </button>
            <button
              onClick={handleRename}
              className="p-2 text-gray-400 hover:text-white transition-colors"
            >
              <Pencil size={16} />
            </button>
            <button
              onClick={() => setDeleteConfirm('open')}
              className="p-2 text-gray-400 hover:text-red-400 transition-colors"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <span className="flex items-center gap-1">
            <Image size={14} /> {pack.status === 'extracting' || pack.status === 'thumbnailing' ? '-' : `${pack.imageCount} 张图片`}
          </span>
          {pack.videoCount > 0 && (
            <span className="flex items-center gap-1">
              <Video size={14} /> {pack.videoCount} 个视频
            </span>
          )}
          <span className="flex items-center gap-1">
            <HardDrive size={14} /> {formatBytes(pack.originalSize)}
          </span>
          <span className={statusColors[pack.status]}>{statusLabels[pack.status]}</span>
        </div>
        {pack.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {pack.tags.map((tag) => (
              <span
                key={tag.id}
                className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-lg"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
        {pack.errorMessage && (
          <p className="text-sm text-red-400 mt-2">错误: {pack.errorMessage}</p>
        )}
      </div>

      {/* Thumbnails grid */}
      {pack.status === 'extracting' || pack.status === 'thumbnailing' ? (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-400 mb-3">图片列表 (-)</h3>
        </div>
      ) : thumbnails.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-400 mb-3">图片列表 ({thumbnails.length})</h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
            {thumbnails.slice(0, 9).map((thumb, i) => (
              <div
                key={thumb.name}
                className="aspect-square bg-gray-800 rounded-lg overflow-hidden cursor-pointer relative"
                onClick={() => setSearchParams({ image: String(i) })}
              >
                <BlurhashPlaceholder
                  hash={thumb.blurhash}
                  width={thumb.width}
                  height={thumb.height}
                  cache={blurhashCache.current}
                  className="absolute inset-0"
                />
                <img
                  src={thumb.thumbUrl}
                  alt={thumb.name}
                  className="w-full h-full object-cover relative z-10"
                  loading="lazy"
                />
                {i === 8 && thumbnails.length > 9 && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-20">
                    <span className="text-white text-lg font-medium">+{thumbnails.length - 9}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Compression config */}
      <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
        <h3 className="text-sm font-medium text-white mb-4">压缩图包</h3>

        {/* Preset selector */}
        {presets.length > 0 && (
          <div className="mb-4">
            <label className="text-xs text-gray-400 mb-2 block">预设</label>
            <div className="flex flex-wrap gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => handlePresetChange(preset.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    selectedPresetId === preset.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {preset.name}
                  {preset.isDefault && <span className="ml-1 text-xs opacity-70">默认</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* File range selector */}
          <div className="mb-4">
            <label className="text-xs text-gray-400 mb-2 block">文件范围</label>
            <button
              onClick={() => setShowFileTree('select')}
              className="w-full flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2 text-sm"
            >
              <span className="text-gray-300">
                {fileSelection && (fileSelection.images.length + fileSelection.videos.length < pack.imageCount + pack.videoCount)
                  ? `已选 ${fileSelection.images.length + fileSelection.videos.length}/${pack.imageCount + pack.videoCount} 个文件`
                  : `全部 ${pack.imageCount + pack.videoCount} 个文件`}
              </span>
              <FolderTree size={14} className="text-gray-500" />
            </button>
          </div>

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between text-sm text-gray-400 hover:text-gray-300 transition-colors py-1"
        >
          <span>详细设置</span>
          <span className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`}>▾</span>
        </button>

        {!showAdvanced && (
          <p className="text-xs text-gray-500 mt-1">
            质量 {options.quality}% ·{' '}
            {options.keepVideos ? '保留视频' : '不含视频'} ·{' '}
            {options.scaleImages ? `缩放至 ${options.maxDimension}px` : '不缩放'}
          </p>
        )}

        {/* Advanced options (collapsed by default) */}
        {showAdvanced && (
          <div className="space-y-4 mt-4">
            {/* Quality slider */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-gray-400">压缩质量</label>
                <span className="text-sm text-white font-medium">{options.quality}%</span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                value={options.quality}
                onChange={(e) => {
                  setOptions({ ...options, quality: parseInt(e.target.value) });
                  setSelectedPresetId(null);
                }}
                className="w-full accent-blue-500"
              />
              <div className="flex justify-between text-xs text-gray-600">
                <span>高压缩</span>
                <span>高质量</span>
              </div>
            </div>

            {/* Toggles */}
            <div className="flex flex-col gap-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-gray-300">保留视频文件</span>
                <button
                  onClick={() => {
                    setOptions({ ...options, keepVideos: !options.keepVideos });
                    setSelectedPresetId(null);
                  }}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    options.keepVideos ? 'bg-blue-600' : 'bg-gray-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                      options.keepVideos ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-gray-300">缩放大图片</span>
                <button
                  onClick={() => {
                    setOptions({ ...options, scaleImages: !options.scaleImages });
                    setSelectedPresetId(null);
                  }}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    options.scaleImages ? 'bg-blue-600' : 'bg-gray-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                      options.scaleImages ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
              </label>

              {options.scaleImages && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs text-gray-400">最大尺寸 (px)</label>
                    <span className="text-sm text-white font-medium">{options.maxDimension}px</span>
                  </div>
                  <input
                    type="range"
                    min="720"
                    max="3840"
                    step="120"
                    value={options.maxDimension}
                    onChange={(e) => {
                      setOptions({ ...options, maxDimension: parseInt(e.target.value) });
                      setSelectedPresetId(null);
                    }}
                    className="w-full accent-blue-500"
                  />
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>720</span>
                    <span>3840</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 mt-6">
          {canGenerate && !isProcessing && (
            <button
              onClick={handleGenerate}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
            >
              <Play size={18} />
              {isGenerated ? '重新生成' : '生成压缩包'}
            </button>
          )}
          {isProcessing && (
            <button
              disabled
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-gray-700 text-gray-400 font-medium rounded-xl"
            >
              <Loader2 size={18} className="animate-spin" />
              {progress?.percentage != null ? `${progress.percentage}%` : '处理中...'}
            </button>
          )}
          {isGenerated && !isProcessing && (
            <button
              onClick={handleDownload}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-green-600 text-white font-medium rounded-xl hover:bg-green-500 transition-colors"
            >
              <Download size={18} />
              下载 <span className="opacity-50">{formatBytes(pack.compressedSize)}</span>
            </button>
          )}
        </div>
      </div>

      {/* Rename modal */}
      {renaming && (
        <Modal
          visible={renaming === 'open'}
          onClose={() => setRenaming('closing')}
          onClosed={() => setRenaming(null)}
        >
          <h3 className="text-white font-medium mb-3 p-5 pb-0">重命名图包</h3>
          <div className="p-5">
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 outline-none mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={() => setRenaming('closing')}
                className="flex-1 py-2 bg-gray-800 text-gray-300 font-medium rounded-lg hover:bg-gray-700 transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmRename}
                disabled={!renameValue.trim()}
                className="flex-1 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                确认
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <Modal
          visible={deleteConfirm === 'open'}
          onClose={() => setDeleteConfirm('closing')}
          onClosed={() => setDeleteConfirm(null)}
        >
          <div className="p-5">
            <h3 className="text-white font-medium mb-2">确认删除</h3>
            <p className="text-gray-400 text-sm mb-4">
              确定要删除「{pack.name}」吗？删除后将同步清除文件系统中的源文件，此操作不可恢复。
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm('closing')}
                className="flex-1 py-2 bg-gray-800 text-gray-300 font-medium rounded-lg hover:bg-gray-700 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 py-2 bg-red-600 text-white font-medium rounded-lg hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {deleting ? '删除中...' : '删除'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Image viewer */}
      {viewerIndex !== null && id && (
        <ImageViewer
          images={images}
          initialIndex={viewerIndex}
          onIndexChange={handleViewerIndexChange}
          onClose={closeViewer}
          showFileTreeButton={true}
          onOpenFileTree={openFileTreeFromViewer}
          blurhashCache={blurhashCache.current}
        />
      )}

      {/* Tag selector */}
      {showTagSelector && id && (
        <TagSelector
          visible={showTagSelector === 'open'}
          selectedIds={pack?.tags.map((t) => t.id) || []}
          onConfirm={async (tagIds) => {
            setShowTagSelector('closing');
            try {
              const updated = await updatePackTags(id, tagIds);
              setPack(updated);
            } catch (err) {
              alert(err instanceof Error ? err.message : '更新标签失败');
            }
          }}
          onClose={() => setShowTagSelector('closing')}
          onClosed={() => setShowTagSelector(null)}
        />
      )}

      {/* File tree panel */}
      {id && (
        <FileTreePanel
          visible={showFileTree !== null}
          mode={showFileTree === 'select' ? 'select' : 'view'}
          tree={fileTree}
          initialSelection={showFileTree === 'select' ? fileSelection : undefined}
          expandedPaths={fileTreeExpandedPaths}
          onExpandedPathsChange={setFileTreeExpandedPaths}
          focusPath={viewerIndex !== null && thumbnails[viewerIndex] && id
            ? (() => {
                // Extract original image path from imageUrl: "/api/packs/{id}/images/NR/scene.png" → "NR/scene.png"
                const prefix = `/api/packs/${id}/images/`;
                const url = thumbnails[viewerIndex].imageUrl;
                return url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
              })()
            : undefined}
          onImageSelect={(imagePath) => {
            // Find the thumbnail index matching this image path
            // imagePath is relative to images dir (e.g. "NR/scene.png")
            // thumbnail.name is the relative path in thumbnails dir (e.g. "NR/scene.jpg")
            const stem = imagePath.replace(/\.[^.]+$/, '');
            const index = thumbnails.findIndex(t => {
              const thumbStem = t.name.replace(/\.jpg$/, '');
              return thumbStem === stem;
            });
            if (index >= 0) setSearchParams({ image: String(index) }, { replace: viewerIndex !== null });
          }}
          onConfirm={showFileTree === 'select' ? (selection) => {
            setFileSelection(selection);
            setShowFileTree(null);
          } : undefined}
          onClose={() => setShowFileTree(null)}
        />
      )}
    </div>
  );
}
