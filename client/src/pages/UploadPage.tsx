import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useUpload } from '../hooks/useUpload';
import { useFolderUpload } from '../hooks/useFolderUpload';
import { clearPacksCache } from '../lib/homeStore';
import { formatBytes } from '../lib/utils';
import { Upload, X, FileArchive, FolderOpen, Lock, Eye, EyeOff, Tag, ChevronDown, ChevronUp } from 'lucide-react';
import TagSelector from '../components/TagSelector';
import Modal from '../components/Modal';
import DuplicateUploadModal from '../components/DuplicateUploadModal';
import { showInfo } from '../components/Toast';
import PixivImport from '../components/PixivImport';
import ImportSources from '../components/ImportSources';
import UploadTask from '../components/UploadTask';
import UploadTaskStatus, { taskActionClass } from '../components/UploadTaskStatus';
import { readUploadTask, forgetUploadTask } from '../lib/uploadTask';

type UploadMode = 'archive' | 'folder' | 'pixiv' | null;

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

export default function UploadPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [restoredTask, setRestoredTask] = useState(readUploadTask);
  const serverFolder = useRef(false);
  // Retire legacy task URLs; task ownership is scoped to this browser session.
  useEffect(() => { if (location.search) navigate('/upload', { replace: true }); }, [location.search, navigate]);

  // Archive upload
  const { matches: duplicateMatches, continueUpload: continueArchive, progress: archiveProgress, status: archiveStatus, error: archiveError, packId: archivePackId, startUpload: startArchiveUpload, pause: pauseArchive, resume: resumeArchive, cancel: cancelArchive, reset: resetArchive } = useUpload();

  // Folder upload
  const { matches: folderMatches, continueUpload: continueFolder, retry: retryFolder, phase: folderPhase, packId: folderPackId, files: folderFiles, overallProgress: folderProgress, error: folderError, scanFiles, startUpload: startFolderUpload, pause: pauseFolder, resume: resumeFolder, cancel: cancelFolder, reset: resetFolder } = useFolderUpload();

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
      const ext = f.name.split('.').pop()?.toLowerCase();
      if (ext !== 'zip' && ext !== 'rar') {
        showInfo('只支持 ZIP、RAR 格式');
        e.target.value = '';
        return;
      }
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
      if (!await cancelArchive()) {
        setCancelConfirm(null);
        return;
      }
    } else if (mode === 'folder') {
      if (!await cancelFolder()) {
        setCancelConfirm(null);
        return;
      }
    }
    setCancelConfirm(null);
    resetToIdle();
  };

  // --- Shared handlers ---

  const resetToIdle = () => {
    forgetUploadTask(); setRestoredTask(null);
    serverFolder.current = false;
    clearPacksCache();
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

  const handleDuplicateCancel = async (targetPackId?: string) => {
    const cancelled = mode === 'folder' ? await cancelFolder() : await cancelArchive();
    if (!cancelled) return;
    resetToIdle();
    if (targetPackId) navigate(`/packs/${targetPackId}`);
  };

  const handleCancelFile = () => {
    setFile(null);
    setPackName('');
    if (!folderScanResult) setMode(null);
  };

  // --- Derived states ---

  if (['checking', 'duplicate', 'thumbnailing', 'done'].includes(folderPhase) && folderPackId) serverFolder.current = true;
  const serverTaskId = archivePackId || (serverFolder.current ? folderPackId : null) || restoredTask;

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-xl font-bold text-white mb-4 h-9 flex items-center">上传图包</h2>

      {!serverTaskId && mode === 'pixiv' && <PixivImport onBack={() => setMode(null)} />}

      {serverTaskId && <UploadTask key={serverTaskId} packId={serverTaskId} onDone={resetToIdle} />}

      <DuplicateUploadModal
        matches={serverTaskId ? [] : mode === 'folder' ? folderMatches : duplicateMatches}
        busy={mode === 'folder' ? ['confirming', 'cancelling'].includes(folderPhase) : ['checking', 'confirming', 'cancelling'].includes(archiveStatus)}
        error={mode === 'folder' ? folderError : archiveError}
        onCancel={() => { void handleDuplicateCancel(); }}
        onContinue={() => { void (mode === 'folder' ? continueFolder() : continueArchive()); }}
        onSelect={id => { void handleDuplicateCancel(id); }}
      />

      {/* Initial: no file/folder selected */}
      {!mode && !serverTaskId && (
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
            accept={isIOS ? undefined : '.zip,.rar'}
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
      {!mode && !serverTaskId && <ImportSources onSelect={setMode} />}
      {mode === 'archive' && file && !serverTaskId && (
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

          {archiveStatus === 'idle' ? <button onClick={handleArchiveStart} className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-xl"><Upload size={18} />开始上传</button> :
            <UploadTaskStatus stage={archiveStatus === 'error' ? '上传失败' : archiveStatus === 'paused' ? '已暂停' : archiveStatus === 'uploading' ? '正在上传' : archiveStatus === 'duplicate' ? '发现重复，等待确认' : archiveStatus === 'cancelling' ? '正在取消…' : '正在检测重复…'}
              progress={['uploading', 'paused'].includes(archiveStatus) ? archiveProgress : undefined} paused={archiveStatus === 'paused'} error={archiveError}>
              {archiveStatus === 'uploading' && <button className={taskActionClass} onClick={pauseArchive}>暂停</button>}
              {['paused', 'error'].includes(archiveStatus) && <button className={taskActionClass} onClick={resumeArchive}>{archiveStatus === 'error' ? '重试' : '继续'}</button>}
              <button disabled={['checking', 'confirming', 'cancelling'].includes(archiveStatus)} className={`${taskActionClass} text-red-300`} onClick={handleCancelClick}>{archiveStatus === 'error' ? '删除任务' : '取消并删除'}</button>
            </UploadTaskStatus>}
        </div>
      )}

      {/* Folder upload form */}
      {mode === 'folder' && !serverTaskId && (
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

          {folderPhase !== 'ready' && <UploadTaskStatus
            stage={folderPhase === 'error' || folderError ? '上传失败' : folderPhase === 'paused' ? '已暂停' : folderPhase === 'uploading' ? '正在上传' : folderPhase === 'cancelling' ? '正在取消…' : '正在准备上传…'}
            progress={['uploading', 'paused'].includes(folderPhase) ? folderProgress : undefined} paused={folderPhase === 'paused'} error={folderError}
            detail={folderFiles.length ? `${folderFiles.filter(f => f.status === 'uploaded').length} / ${folderFiles.length} 个文件` : undefined}>
            {folderPhase === 'uploading' && <button className={taskActionClass} onClick={pauseFolder}>暂停</button>}
            {folderPhase === 'paused' && <button className={taskActionClass} onClick={resumeFolder}>继续</button>}
            {(folderPhase === 'error' || folderError) && <button className={taskActionClass} onClick={() => void retryFolder()}>重试</button>}
            <button disabled={['creating', 'scanning', 'confirming', 'cancelling'].includes(folderPhase)} className={`${taskActionClass} text-red-300`} onClick={handleCancelClick}>{folderPhase === 'error' || folderError ? '删除任务' : '取消并删除'}</button>
          </UploadTaskStatus>}
          {(folderPhase === 'uploading' || folderPhase === 'paused' || folderPhase === 'error') && (
            <div className="mt-3">
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

          {folderPhase === 'ready' && <button onClick={handleFolderStart} className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-xl"><Upload size={18} />开始上传</button>}
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
