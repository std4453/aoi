import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePresets } from '../hooks/usePresets';
import type { CompressionOptions } from '../../../shared/types.js';
import { ArrowLeft, Plus, Trash2, Star, Edit3, Check, X } from 'lucide-react';

const DEFAULT_OPTIONS: CompressionOptions = {
  format: 'jpeg',
  quality: 80,
  keepVideos: true,
  scaleImages: true,
  maxDimension: 1920,
};

export default function PresetsPage() {
  const navigate = useNavigate();
  const { presets, loading, add, edit, remove, setDefault } = usePresets();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formOptions, setFormOptions] = useState<CompressionOptions>({ ...DEFAULT_OPTIONS });
  const [formIsDefault, setFormIsDefault] = useState(false);

  const startAdd = () => {
    setEditingId(null);
    setFormName('');
    setFormOptions({ ...DEFAULT_OPTIONS });
    setFormIsDefault(false);
    setShowForm(true);
  };

  const startEdit = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setEditingId(id);
    setFormName(preset.name);
    setFormOptions({ ...preset.options });
    setFormIsDefault(preset.isDefault);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    if (editingId) {
      await edit(editingId, formName.trim(), formOptions);
      setEditingId(null);
    } else {
      await add(formName.trim(), formOptions, formIsDefault);
      setShowForm(false);
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormName('');
    setFormOptions({ ...DEFAULT_OPTIONS });
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定要删除预设「${name}」吗？`)) return;
    await remove(id);
  };

  const handleSetDefault = async (id: string) => {
    await setDefault(id);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

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

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">压缩预设</h2>
        <button
          onClick={startAdd}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 transition-colors"
        >
          <Plus size={18} />
          新建
        </button>
      </div>

      {/* New preset form */}
      {showForm && (
        <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 mb-4">
          <h3 className="text-sm font-medium text-white mb-4">新建预设</h3>

          <div className="space-y-4">
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">名称</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 outline-none"
                placeholder="预设名称"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-gray-400">压缩质量</label>
                <span className="text-sm text-white font-medium">{formOptions.quality}%</span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                value={formOptions.quality}
                onChange={(e) => setFormOptions({ ...formOptions, quality: parseInt(e.target.value) })}
                className="w-full accent-blue-500"
              />
            </div>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-gray-300">保留视频</span>
              <button
                onClick={() => setFormOptions({ ...formOptions, keepVideos: !formOptions.keepVideos })}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  formOptions.keepVideos ? 'bg-blue-600' : 'bg-gray-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                    formOptions.keepVideos ? 'translate-x-5' : ''
                  }`}
                />
              </button>
            </label>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-gray-300">缩放大图片</span>
              <button
                onClick={() => setFormOptions({ ...formOptions, scaleImages: !formOptions.scaleImages })}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  formOptions.scaleImages ? 'bg-blue-600' : 'bg-gray-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                    formOptions.scaleImages ? 'translate-x-5' : ''
                  }`}
                />
              </button>
            </label>

            {formOptions.scaleImages && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-gray-400">最大尺寸</label>
                  <span className="text-sm text-white font-medium">{formOptions.maxDimension}px</span>
                </div>
                <input
                  type="range"
                  min="720"
                  max="3840"
                  step="120"
                  value={formOptions.maxDimension}
                  onChange={(e) => setFormOptions({ ...formOptions, maxDimension: parseInt(e.target.value) })}
                  className="w-full accent-blue-500"
                />
              </div>
            )}

            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-gray-300">设为默认预设</span>
              <button
                onClick={() => setFormIsDefault(!formIsDefault)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  formIsDefault ? 'bg-blue-600' : 'bg-gray-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                    formIsDefault ? 'translate-x-5' : ''
                  }`}
                />
              </button>
            </label>
          </div>

          <div className="flex gap-2 mt-6">
            <button
              onClick={handleSave}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-500 transition-colors"
            >
              <Check size={16} />
              保存
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="flex items-center justify-center px-4 py-2.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Preset list */}
      <div className="space-y-2">
        {presets.map((preset) => (
          <div key={preset.id}>
            {editingId === preset.id ? (
              /* Inline edit form */
              <div className="bg-gray-900 rounded-xl p-4 border border-blue-600/50 space-y-4">
                <h3 className="text-sm font-medium text-white">编辑预设</h3>

                <div>
                  <label className="text-xs text-gray-400 mb-1.5 block">名称</label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-blue-500 outline-none"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs text-gray-400">压缩质量</label>
                    <span className="text-sm text-white font-medium">{formOptions.quality}%</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={formOptions.quality}
                    onChange={(e) => setFormOptions({ ...formOptions, quality: parseInt(e.target.value) })}
                    className="w-full accent-blue-500"
                  />
                </div>

                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm text-gray-300">保留视频</span>
                  <button
                    onClick={() => setFormOptions({ ...formOptions, keepVideos: !formOptions.keepVideos })}
                    className={`relative w-11 h-6 rounded-full transition-colors ${
                      formOptions.keepVideos ? 'bg-blue-600' : 'bg-gray-700'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                        formOptions.keepVideos ? 'translate-x-5' : ''
                      }`}
                    />
                  </button>
                </label>

                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm text-gray-300">缩放大图片</span>
                  <button
                    onClick={() => setFormOptions({ ...formOptions, scaleImages: !formOptions.scaleImages })}
                    className={`relative w-11 h-6 rounded-full transition-colors ${
                      formOptions.scaleImages ? 'bg-blue-600' : 'bg-gray-700'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                        formOptions.scaleImages ? 'translate-x-5' : ''
                      }`}
                    />
                  </button>
                </label>

                {formOptions.scaleImages && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs text-gray-400">最大尺寸</label>
                      <span className="text-sm text-white font-medium">{formOptions.maxDimension}px</span>
                    </div>
                    <input
                      type="range"
                      min="720"
                      max="3840"
                      step="120"
                      value={formOptions.maxDimension}
                      onChange={(e) => setFormOptions({ ...formOptions, maxDimension: parseInt(e.target.value) })}
                      className="w-full accent-blue-500"
                    />
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-500 transition-colors"
                  >
                    <Check size={16} />
                    保存
                  </button>
                  <button
                    onClick={cancelEdit}
                    className="flex items-center justify-center px-4 py-2.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ) : (
              /* Normal preset card */
              <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-white truncate">{preset.name}</h3>
                    {preset.isDefault && (
                      <span className="text-xs bg-blue-600/20 text-blue-400 px-2 py-0.5 rounded-full">
                        默认
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    质量 {preset.options.quality}% ·{' '}
                    {preset.options.keepVideos ? '保留视频' : '不含视频'} ·{' '}
                    {preset.options.scaleImages ? `缩放至 ${preset.options.maxDimension}px` : '不缩放'}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleSetDefault(preset.id)}
                    className="p-2 text-gray-500 hover:text-yellow-400 rounded-lg hover:bg-gray-800 transition-colors"
                    title="设为默认"
                  >
                    {preset.isDefault ? <Star size={16} className="fill-current text-yellow-400" /> : <Star size={16} />}
                  </button>
                  <button
                    onClick={() => startEdit(preset.id)}
                    className="p-2 text-gray-500 hover:text-white rounded-lg hover:bg-gray-800 transition-colors"
                    title="编辑"
                  >
                    <Edit3 size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(preset.id, preset.name)}
                    className="p-2 text-gray-500 hover:text-red-400 rounded-lg hover:bg-gray-800 transition-colors"
                    title="删除"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {presets.length === 0 && !showForm && (
          <div className="text-center py-12 text-gray-500">
            <p className="text-sm">还没有预设</p>
            <p className="text-xs mt-1">点击「新建」创建第一个压缩预设</p>
          </div>
        )}
      </div>
    </div>
  );
}
