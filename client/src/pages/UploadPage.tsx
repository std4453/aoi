import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUpload } from '../hooks/useUpload';
import { useFolderUpload } from '../hooks/useFolderUpload';
import { clearPacksCache } from '../lib/homeStore';
import { formatBytes } from '../lib/utils';
import { Upload, Pause, Play, X, CheckCircle, AlertCircle, FileArchive, FolderOpen, Lock, Eye, EyeOff, Tag, ChevronDown, ChevronUp } from 'lucide-react';
import TagSelector from '../components/TagSelector';
import Modal from '../components/Modal';
import { showInfo } from '../components/Toast';

type UploadMode = 'archive' | 'folder' | null;

export default function UploadPage() {
  const navigate = useNavigate();

  // Archive upload
  const { progress: archiveProgress, status: archiveStatus, error: archiveError, packId: archivePackId, startUpload: startArchiveUpload, pause: pauseArchive, resume: resumeArchive, cancel: cancelArchive, reset: resetArchive } = useUpload();

  // Folder upload
  const { phase: folderPhase, packId: folderPackId, files: folderFiles, overallProgress: folderProgress, error: folderError, scanFiles, startUpload: startFolderUpload, pause: pauseFolder, resume: resumeFolder, cancel: cancelFolder, reset: resetFolder } = useFolderUpload();

  const [mode, setMode] = useState<UploadMode>(null);
  const [cancelConfirm, setCancelConfirm] = useState<null | 'open' | 'closing'>(null);
  const [dragOver, setDragOver] = useState(false);

  // Archive state
  const [file, setFile] = useState<File | null>(null);
  const [packName, setPackName] = useState('');
  const [archivePassword, setArchivePassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Folder state
  const [folderScanResult, setFolderScanResult] = useState<{ scanFiles: { relativePath: string; fileSize: number }[]; fileObjects: File[]; totalSize: number } | null>(null);
  const [showFileDetails, setShowFileDetails] = useState(false);

  // Shared state
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [showTagSelector, setShowTagSelector] = useState<null | 'open' | 'closing'>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileDetailsRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);
  const prevUploadingIdsRef = useRef<Set<string>>(new Set());

  // Auto-scroll file details when a new file starts uploading
  useEffect(() => {
    if (!showFileDetails || !fileDetailsRef.current) return;
    const currentUploadingIds = new Set(
      folderFiles.filter(f => f.status === 'uploading').map(f => f.packFileId)
    );
    // Find newly started uploads
    for (const id of currentUploadingIds) {
      if (!prevUploadingIdsRef.current.has(id)) {
        // If user hasn't scrolled in the last 300ms, auto-scroll to this file
        if (Date.now() - lastUserScrollRef.current > 300) {
          const el = fileDetailsRef.current.querySelector(`[data-pack-file-id="${id}"]`);
          el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }
    prevUploadingIdsRef.current = currentUploadingIds;
  }, [folderFiles, showFileDetails]);

  // --- Archive handlers ---

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setMode('archive');
      setFile(f);
      setPackName(f.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const items = e.dataTransfer.items;
    if (!items || items.length === 0) return;

    // Use webkitGetAsEntry to detect file vs directory
    const entry = items[0].webkitGetAsEntry?.();
    if (!entry) {
      // Fallback: treat as file
      const f = e.dataTransfer.files?.[0];
      if (f) {
        const ext = f.name.split('.').pop()?.toLowerCase();
        if (ext !== 'zip' && ext !== 'rar') {
          showInfo('只支持 ZIP、RAR 格式或文件夹');
          return;
        }
        setMode('archive');
        setFile(f);
        setPackName(f.name.replace(/\.[^/.]+$/, ''));
      }
      return;
    }

    if (entry.isDirectory) {
      // Dropped a folder — read all files recursively
      const dirEntry = entry as FileSystemDirectoryEntry;
      const files = await readDirectoryRecursive(dirEntry, dirEntry.name);
      if (files.length === 0) {
        showInfo('文件夹为空');
        return;
      }
      setMode('folder');
      const result = scanFiles(createFileListProxy(files));
      setFolderScanResult(result);
      setPackName(dirEntry.name);
    } else if (entry.isFile) {
      // Dropped a file — check extension
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      const ext = f.name.split('.').pop()?.toLowerCase();
      if (ext !== 'zip' && ext !== 'rar') {
        showInfo('只支持 ZIP、RAR 格式或文件夹');
        return;
      }
      setMode('archive');
      setFile(f);
      setPackName(f.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only trigger if leaving the drop zone itself (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);

  // Recursively read a FileSystemDirectoryEntry and return File[] with webkitRelativePath
  async function readDirectoryRecursive(
    dirEntry: FileSystemDirectoryEntry,
    rootName: string,
  ): Promise<File[]> {
    const result: File[] = [];

    async function readEntries(entry: FileSystemDirectoryEntry, path: string): Promise<void> {
      const reader = entry.createReader();
      // readEntries may not return all entries in one call — loop until empty
      const entries: FileSystemEntry[] = [];
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        entries.push(...batch);
      } while (batch.length > 0);

      for (const child of entries) {
        const childPath = `${path}/${child.name}`;
        if (child.isFile) {
          const file = await new Promise<File>((resolve, reject) => {
            (child as FileSystemFileEntry).file(resolve, reject);
          });
          // Patch webkitRelativePath so scanFiles can read it
          Object.defineProperty(file, 'webkitRelativePath', { value: childPath, writable: false });
          result.push(file);
        } else if (child.isDirectory) {
          await readEntries(child as FileSystemDirectoryEntry, childPath);
        }
      }
    }

    await readEntries(dirEntry, rootName);
    return result;
  }

  // Create an object that quacks like FileList for scanFiles
  function createFileListProxy(files: File[]): FileList {
    return {
      length: files.length,
      item: (i: number) => files[i] ?? null,
      [Symbol.iterator]() {
        let i = 0;
        return { next: () => i < files.length ? { value: files[i++], done: false } : { value: undefined, done: true } };
      },
      ...Object.fromEntries(files.map((f, i) => [i, f])),
    } as FileList;
  }

  const handleArchiveStart = () => {
    if (!file) return;
    startArchiveUpload(file, packName, archivePassword || undefined, selectedTagIds);
  };

  // --- Folder handlers ---

  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    setMode('folder');
    const result = scanFiles(fileList);
    setFolderScanResult(result);

    // Extract folder name from first file's relative path
    const firstPath = fileList[0].webkitRelativePath;
    const folderName = firstPath.split('/')[0];
    setPackName(folderName);
  };

  const handleFolderStart = () => {
    if (!folderScanResult) return;
    startFolderUpload(packName, folderScanResult, selectedTagIds);
  };

  // --- Cancel handlers ---

  const handleCancelClick = () => {
    setCancelConfirm('open');
  };

  const handleCancelConfirm = async () => {
    setCancelConfirm('closing');
    if (mode === 'archive') {
      cancelArchive();
    } else if (mode === 'folder') {
      await cancelFolder();
    }
    setCancelConfirm(null);
    resetToIdle();
  };

  // --- Shared handlers ---

  const resetToIdle = () => {
    setMode(null);
    setFile(null);
    setPackName('');
    setArchivePassword('');
    setShowPassword(false);
    setFolderScanResult(null);
    setShowFileDetails(false);
    setSelectedTagIds([]);
    resetArchive();
    resetFolder();
  };

  const handleDone = () => {
    resetToIdle();
    clearPacksCache();
  };

  const handleViewPack = () => {
    const pid = mode === 'archive' ? archivePackId : folderPackId;
    resetToIdle();
    if (pid) {
      navigate(`/packs/${pid}`);
    }
  };

  const handleCancelFile = () => {
    setFile(null);
    setPackName('');
    if (!folderScanResult) setMode(null);
  };

  // --- Derived states ---

  const isArchiveActive = archiveStatus === 'uploading' || archiveStatus === 'paused';
  const isFolderActive = folderPhase === 'uploading' || folderPhase === 'paused';
  const isArchiveDone = archiveStatus === 'done';
  const isFolderDone = folderPhase === 'done';
  const isAnyDone = isArchiveDone || isFolderDone;

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-xl font-bold text-white mb-4 h-9 flex items-center">上传图包</h2>

      {/* Initial: no file/folder selected */}
      {!mode && (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={`border-2 border-dashed rounded-2xl p-8 text-center transition-colors ${
            dragOver
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-gray-700 hover:border-gray-500'
          }`}
        >
          <Upload size={48} className={`mx-auto mb-4 transition-colors ${dragOver ? 'text-blue-400' : 'text-gray-600'}`} />
          <p className={`mb-4 transition-colors ${dragOver ? 'text-blue-300' : 'text-gray-400'}`}>
            {dragOver ? '松开以上传' : '点击选择文件或文件夹'}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-5 py-2.5 bg-gray-800 text-gray-300 rounded-xl hover:bg-gray-700 transition-colors text-sm"
            >
              <FileArchive size={16} />
              选择压缩包
            </button>
            <button
              onClick={() => folderInputRef.current?.click()}
              className="flex items-center gap-2 px-5 py-2.5 bg-gray-800 text-gray-300 rounded-xl hover:bg-gray-700 transition-colors text-sm"
            >
              <FolderOpen size={16} />
              选择文件夹
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-3">支持 ZIP、RAR 格式，或直接上传文件夹</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.rar"
            onChange={handleFileSelect}
            className="hidden"
          />
          <input
            ref={folderInputRef}
            type="file"
            {...({ webkitdirectory: '', directory: '' } as any)}
            onChange={handleFolderSelect}
            className="hidden"
          />
        </div>
      )}

      {/* Archive upload form */}
      {mode === 'archive' && file && !isArchiveDone && (
        <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          {/* File info */}
          <div className="mb-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={packName}
                onChange={(e) => setPackName(e.target.value)}
                disabled={archiveStatus !== 'idle'}
                className="flex-1 min-w-0 bg-transparent text-white text-lg font-medium border-b border-gray-700 focus:border-blue-500 outline-none pb-1 mb-1"
                placeholder="图包名称"
              />
              {archiveStatus === 'idle' && (
                <button
                  type="button"
                  onClick={handleCancelFile}
                  className="p-1 text-gray-500 hover:text-white transition-colors shrink-0"
                  title="取消选择"
                >
                  <X size={18} />
                </button>
              )}
            </div>
            <p className="text-sm text-gray-500">
              {file.name} · {formatBytes(file.size)}
            </p>
          </div>

          {/* Archive password */}
          <div className="mb-3">
            <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
              <Lock size={16} className="text-gray-500 shrink-0" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={archivePassword}
                onChange={(e) => setArchivePassword(e.target.value)}
                disabled={archiveStatus !== 'idle'}
                className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-gray-500 disabled:opacity-50"
                placeholder="压缩包密码"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="text-gray-500 hover:text-gray-300 transition-colors shrink-0"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Tags */}
          <div className="mb-3">
            <button
              type="button"
              onClick={() => archiveStatus === 'idle' && setShowTagSelector('open')}
              disabled={archiveStatus !== 'idle'}
              className="w-full flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-left disabled:opacity-50"
            >
              <Tag size={16} className="text-gray-500 shrink-0" />
              {selectedTagIds.length > 0 ? (
                <span className="text-sm text-gray-300 truncate">已选择 {selectedTagIds.length} 个标签</span>
              ) : (
                <span className="text-sm text-gray-500">选择标签</span>
              )}
            </button>
          </div>

          {/* Progress */}
          {(archiveStatus === 'uploading' || archiveStatus === 'paused') && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="text-gray-400">
                  {archiveStatus === 'paused' ? '已暂停' : '上传中...'}
                </span>
                <span className="text-white font-medium">{archiveProgress}%</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${archiveProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {archiveStatus === 'idle' && (
              <button
                onClick={handleArchiveStart}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
              >
                <Upload size={18} />
                开始上传
              </button>
            )}
            {archiveStatus === 'uploading' && (
              <button
                onClick={pauseArchive}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-yellow-600 text-white font-medium rounded-xl hover:bg-yellow-500 transition-colors"
              >
                <Pause size={18} />
                暂停
              </button>
            )}
            {archiveStatus === 'paused' && (
              <button
                onClick={resumeArchive}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
              >
                <Play size={18} />
                继续
              </button>
            )}
            {isArchiveActive && (
              <button
                onClick={handleCancelClick}
                className="flex items-center justify-center p-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
              >
                <X size={18} />
              </button>
            )}
          </div>

          {/* Error */}
          {archiveError && archiveStatus === 'error' && (
            <div className="mt-4 p-3 bg-red-900/30 border border-red-800 rounded-xl flex items-start gap-2">
              <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-red-400 text-sm">{archiveError}</p>
                <button
                  onClick={resumeArchive}
                  className="text-red-300 text-sm underline mt-1"
                >
                  重试
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Folder upload form */}
      {mode === 'folder' && !isFolderDone && (
        <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          {/* Folder info */}
          <div className="mb-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={packName}
                onChange={(e) => setPackName(e.target.value)}
                disabled={folderPhase !== 'ready'}
                className="flex-1 min-w-0 bg-transparent text-white text-lg font-medium border-b border-gray-700 focus:border-blue-500 outline-none pb-1 mb-1"
                placeholder="图包名称"
              />
              {folderPhase === 'ready' && (
                <button
                  type="button"
                  onClick={() => {
                    setFolderScanResult(null);
                    setPackName('');
                    setMode(null);
                  }}
                  className="p-1 text-gray-500 hover:text-white transition-colors shrink-0"
                  title="取消选择"
                >
                  <X size={18} />
                </button>
              )}
            </div>
            {folderScanResult && (
              <p className="text-sm text-gray-500">
                {folderScanResult.scanFiles.length} 个文件 · {formatBytes(folderScanResult.totalSize)}
              </p>
            )}
          </div>

          {/* No password field for folder uploads */}

          {/* Tags */}
          <div className="mb-3">
            <button
              type="button"
              onClick={() => folderPhase === 'ready' && setShowTagSelector('open')}
              disabled={folderPhase !== 'ready'}
              className="w-full flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-left disabled:opacity-50"
            >
              <Tag size={16} className="text-gray-500 shrink-0" />
              {selectedTagIds.length > 0 ? (
                <span className="text-sm text-gray-300 truncate">已选择 {selectedTagIds.length} 个标签</span>
              ) : (
                <span className="text-sm text-gray-500">选择标签</span>
              )}
            </button>
          </div>

          {/* Progress */}
          {(folderPhase === 'uploading' || folderPhase === 'paused') && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="text-gray-400">
                  {folderPhase === 'paused' ? '已暂停' : '上传中...'}
                  <span className="text-gray-500 ml-1.5">
                    {folderFiles.filter(f => f.status === 'uploaded').length}/{folderFiles.length} 已上传
                  </span>
                </span>
                <span className="text-white font-medium">{folderProgress}%</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${folderProgress}%` }}
                />
              </div>

              {/* Expandable file details */}
              <button
                onClick={() => setShowFileDetails(!showFileDetails)}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 mt-2 transition-colors"
              >
                {showFileDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {showFileDetails ? '收起详情' : '查看详情'}
              </button>
              {showFileDetails && (
                <div
                  ref={fileDetailsRef}
                  onScroll={() => { lastUserScrollRef.current = Date.now(); }}
                  className="mt-2 max-h-60 overflow-y-auto space-y-1"
                >
                  {folderFiles.map(f => (
                    <div key={f.packFileId || f.relativePath} data-pack-file-id={f.packFileId} className="flex items-center gap-2 text-xs">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        f.status === 'uploaded' ? 'bg-green-500' :
                        f.status === 'uploading' ? 'bg-blue-500 animate-pulse' :
                        f.status === 'failed' ? 'bg-red-500' :
                        'bg-gray-600'
                      }`} />
                      <span className="text-gray-400 truncate flex-1" title={f.relativePath}>
                        {f.relativePath}
                      </span>
                      <span className="text-gray-500 shrink-0">
                        {f.status === 'uploaded' ? '完成' :
                         f.status === 'failed' ? '失败' :
                         f.status === 'uploading' ? `${f.progress}%` :
                         '等待中'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {folderPhase === 'scanning' && (
              <button
                disabled
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-gray-700 text-gray-400 font-medium rounded-xl cursor-not-allowed"
              >
                扫描中...
              </button>
            )}
            {folderPhase === 'ready' && (
              <button
                onClick={handleFolderStart}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
              >
                <Upload size={18} />
                开始上传
              </button>
            )}
            {folderPhase === 'uploading' && (
              <button
                onClick={pauseFolder}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-yellow-600 text-white font-medium rounded-xl hover:bg-yellow-500 transition-colors"
              >
                <Pause size={18} />
                暂停
              </button>
            )}
            {folderPhase === 'paused' && (
              <button
                onClick={resumeFolder}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
              >
                <Play size={18} />
                继续
              </button>
            )}
            {isFolderActive && (
              <button
                onClick={handleCancelClick}
                className="flex items-center justify-center p-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
              >
                <X size={18} />
              </button>
            )}
          </div>

          {/* Error */}
          {folderError && folderPhase === 'error' && (
            <div className="mt-4 p-3 bg-red-900/30 border border-red-800 rounded-xl flex items-start gap-2">
              <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-red-400 text-sm">{folderError}</p>
            </div>
          )}
        </div>
      )}

      {/* Success (both archive and folder) */}
      {isAnyDone && (
        <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800 text-center">
          <CheckCircle size={48} className="mx-auto text-green-400 mb-4" />
          <p className="text-white font-medium mb-1">上传完成</p>
          <p className="text-gray-400 text-sm mb-6">
            图包正在后台处理中，请稍候...
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleViewPack}
              className="flex-1 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
            >
              查看图包
            </button>
            <button
              onClick={handleDone}
              className="flex-1 py-3 bg-gray-800 text-gray-300 font-medium rounded-xl hover:bg-gray-700 transition-colors"
            >
              继续上传
            </button>
          </div>
        </div>
      )}

      {/* Cancel confirmation dialog */}
      {cancelConfirm && (
        <Modal
          visible={cancelConfirm === 'open'}
          onClose={() => setCancelConfirm('closing')}
          onClosed={() => setCancelConfirm(null)}
        >
          <div className="p-5">
            <h3 className="text-white font-medium mb-2">确认取消</h3>
            <p className="text-gray-400 text-sm mb-5">
              确定要取消上传吗？已上传的文件将被删除，此操作不可恢复。
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setCancelConfirm('closing')}
                className="flex-1 py-2.5 bg-gray-800 text-gray-300 font-medium rounded-xl hover:bg-gray-700 transition-colors"
              >
                继续上传
              </button>
              <button
                onClick={handleCancelConfirm}
                className="flex-1 py-2.5 bg-red-600 text-white font-medium rounded-xl hover:bg-red-500 transition-colors"
              >
                确认取消
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Tag selector */}
      {showTagSelector && (
        <TagSelector
          visible={showTagSelector === 'open'}
          selectedIds={selectedTagIds}
          onConfirm={(ids) => {
            setSelectedTagIds(ids);
            setShowTagSelector('closing');
          }}
          onClose={() => setShowTagSelector('closing')}
          onClosed={() => setShowTagSelector(null)}
        />
      )}
    </div>
  );
}
