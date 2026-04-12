import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUpload } from '../hooks/useUpload';
import { usePacks } from '../hooks/usePacks';
import { formatBytes } from '../lib/utils';
import { Upload, Pause, Play, X, CheckCircle, AlertCircle, FileArchive, Lock, Eye, EyeOff, Tag } from 'lucide-react';
import TagSelector from '../components/TagSelector';

export default function UploadPage() {
  const navigate = useNavigate();
  const { refresh } = usePacks();
  const { progress, status, error, packId, startUpload, pause, resume, cancel, reset } = useUpload();
  const [file, setFile] = useState<File | null>(null);
  const [packName, setPackName] = useState('');
  const [archivePassword, setArchivePassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [showTagSelector, setShowTagSelector] = useState<null | 'open' | 'closing'>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setPackName(f.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setFile(f);
      setPackName(f.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleStart = () => {
    if (!file) return;
    startUpload(file, packName, archivePassword || undefined, selectedTagIds);
  };

  const handleDone = () => {
    reset();
    setFile(null);
    setPackName('');
    setArchivePassword('');
    refresh();
  };

  const handleViewPack = () => {
    handleDone();
    if (packId) {
      navigate(`/packs/${packId}`);
    }
  };

  const handleCancelFile = () => {
    setFile(null);
    setPackName('');
  };

  const isIdle = status === 'idle';
  const isActive = status === 'uploading' || status === 'paused';
  const isError = status === 'error';

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-xl font-bold text-white mb-4 h-9 flex items-center">上传图包</h2>

      {isIdle && !file && (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-2 border-dashed border-gray-700 rounded-2xl p-8 text-center hover:border-gray-500 transition-colors cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <FileArchive size={48} className="mx-auto text-gray-600 mb-4" />
          <p className="text-gray-400 mb-2">点击选择或拖放文件到此处</p>
          <p className="text-xs text-gray-600">支持 ZIP、RAR 格式</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.rar"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      )}

      {file && (isIdle || isActive || isError) && (
        <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          {/* File info */}
          <div className="mb-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={packName}
                onChange={(e) => setPackName(e.target.value)}
                disabled={!isIdle}
                className="flex-1 min-w-0 bg-transparent text-white text-lg font-medium border-b border-gray-700 focus:border-blue-500 outline-none pb-1 mb-1"
                placeholder="图包名称"
              />
              {isIdle && (
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
                disabled={!isIdle}
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
              onClick={() => isIdle && setShowTagSelector('open')}
              disabled={!isIdle}
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
          {(status === 'uploading' || status === 'paused') && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="text-gray-400">
                  {status === 'paused' ? '已暂停' : '上传中...'}
                </span>
                <span className="text-white font-medium">{progress}%</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {isIdle && (
              <button
                onClick={handleStart}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
              >
                <Upload size={18} />
                开始上传
              </button>
            )}
            {status === 'uploading' && (
              <button
                onClick={pause}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-yellow-600 text-white font-medium rounded-xl hover:bg-yellow-500 transition-colors"
              >
                <Pause size={18} />
                暂停
              </button>
            )}
            {status === 'paused' && (
              <button
                onClick={resume}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
              >
                <Play size={18} />
                继续
              </button>
            )}
            {isActive && (
              <button
                onClick={cancel}
                className="flex items-center justify-center p-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
              >
                <X size={18} />
              </button>
            )}
          </div>

          {/* Error */}
          {error && status === 'error' && (
            <div className="mt-4 p-3 bg-red-900/30 border border-red-800 rounded-xl flex items-start gap-2">
              <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-red-400 text-sm">{error}</p>
                <button
                  onClick={resume}
                  className="text-red-300 text-sm underline mt-1"
                >
                  重试
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Success */}
      {status === 'done' && (
        <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800 text-center">
          <CheckCircle size={48} className="mx-auto text-green-400 mb-4" />
          <p className="text-white font-medium mb-1">上传完成</p>
          <p className="text-gray-400 text-sm mb-6">
            图包正在后台解压处理中，请稍候...
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleViewPack}
              className="flex-1 py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors"
            >
              查看图包
            </button>
            <button
              onClick={() => {
                reset();
                setFile(null);
                setPackName('');
                setArchivePassword('');
                setSelectedTagIds([]);
              }}
              className="flex-1 py-3 bg-gray-800 text-gray-300 font-medium rounded-xl hover:bg-gray-700 transition-colors"
            >
              继续上传
            </button>
          </div>
        </div>
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
