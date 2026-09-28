import { activeServer, clearServerCache, returnToServers, runtime } from '../lib/connection';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api/client';
import { fetchTags } from '../api/packs';
import { fetchPresets } from '../api/presets';
import { formatBytes } from '../lib/utils';
import { ChevronRight, HardDrive, Server, Tag, SlidersHorizontal } from 'lucide-react';

interface DiskInfo {
  disk: { free: number; size: number; used: number };
  dataUsed: number;
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const [cacheBytes, setCacheBytes] = useState(0);
  const [cacheMessage, setCacheMessage] = useState('');
  const [cacheSupported, setCacheSupported] = useState(false);
  useEffect(() => {
    if (!('caches' in window) || !navigator.serviceWorker?.controller) return;
    setCacheSupported(true);
    void (async () => {
      let total = 0;
      for (const name of (await caches.keys()).filter(name => name.startsWith('aoi-data-'))) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          total += Number(response?.headers.get('X-AoI-Size') || 0);
        }
      }
      setCacheBytes(total);
    })().catch(() => setCacheMessage('无法读取缓存用量'));
  }, []);
  const [diskInfo, setDiskInfo] = useState<DiskInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tagCount, setTagCount] = useState(0);
  const [presetCount, setPresetCount] = useState(0);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [info, tags, presets] = await Promise.all([
          get<DiskInfo>('/system/disk-space'),
          fetchTags().catch(() => []),
          fetchPresets().catch(() => []),
        ]);
        setDiskInfo(info);
        setTagCount((tags as any[]).length);
        setPresetCount((presets as any[]).length);
      } catch (err) {
        console.error('Failed to load info:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-4 h-9 flex items-center">设置</h2>

      <div className="space-y-3">
        <button
          type="button"
          onClick={returnToServers}
          className="w-full bg-gray-900 rounded-xl p-4 border border-gray-800 flex items-center gap-3 hover:border-gray-700 transition-colors text-left"
        >
          <Server size={22} className="shrink-0 text-blue-400" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-white">{runtime.serverSelectionEnabled ? '切换服务器' : '返回登录'}</span>
            <span className="block text-xs text-gray-400 mt-1 truncate">{activeServer?.alias}</span>
            <span className="block text-xs text-gray-500 mt-0.5 truncate">{activeServer?.address}</span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-gray-500" />
        </button>
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 space-y-3">
          <h3 className="text-sm font-medium text-white">离线缓存</h3>
          <p className="text-sm text-gray-400">{cacheSupported ? `所有服务器合计 ${formatBytes(cacheBytes)} / 200 MiB` : '离线缓存未启用，请通过 HTTPS 安装或访问应用。'}</p>
          <p className="text-xs text-gray-500">仅保存请求过的列表、详情和缩略图，不缓存原图。浏览器可能自动回收缓存。</p>
          {cacheSupported && <button className="text-blue-400 text-sm" onClick={async () => {
            try {
              if (activeServer) await clearServerCache(activeServer.id);
              setCacheMessage('当前服务器缓存已清空，后续请求会重新缓存');
              let total = 0;
              for (const name of (await caches.keys()).filter(name => name.startsWith('aoi-data-'))) {
                const cache = await caches.open(name);
                for (const request of await cache.keys()) total += Number((await cache.match(request))?.headers.get('X-AoI-Size') || 0);
              }
              setCacheBytes(total);
            } catch { setCacheMessage('清理失败，请重试'); }
          }}>清空当前服务器缓存</button>}
          {cacheMessage && <p role="status" className="text-sm text-gray-400">{cacheMessage}</p>}
        </div>
        {/* System info */}
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <div className="flex items-center gap-2 mb-3">
            <HardDrive size={18} className="text-gray-400" />
            <h3 className="text-sm font-medium text-white">存储信息</h3>
          </div>
          {loading ? (
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-gray-500">磁盘使用</span>
                  <span className="text-gray-700">--- / ---</span>
                </div>
                <div className="h-2 bg-gray-800 rounded-full" />
                <p className="text-xs text-gray-700 mt-1">剩余 ---</p>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">图包数据</span>
                <span className="text-gray-700">---</span>
              </div>
            </div>
          ) : diskInfo ? (
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                  <span>磁盘使用</span>
                  <span>
                    {formatBytes(diskInfo.disk.used)} / {formatBytes(diskInfo.disk.size)}
                  </span>
                </div>
                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all"
                    style={{
                      width: `${(diskInfo.disk.used / diskInfo.disk.size) * 100}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  剩余 {formatBytes(diskInfo.disk.free)}
                </p>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">图包数据</span>
                <span className="text-white">{formatBytes(diskInfo.dataUsed)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">无法获取磁盘信息</p>
          )}
        </div>

        {/* Tag management entry */}
        <button
          onClick={() => navigate('/settings/tags')}
          className="w-full bg-gray-900 rounded-xl p-4 border border-gray-800 flex items-center justify-between hover:border-gray-700 transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            <Tag size={18} className="text-gray-400" />
            <span className="text-sm font-medium text-white">标签管理</span>
          </div>
          <span className="text-sm text-gray-500">{tagCount} 个标签</span>
        </button>

        {/* Preset management entry */}
        <button
          onClick={() => navigate('/settings/presets')}
          className="w-full bg-gray-900 rounded-xl p-4 border border-gray-800 flex items-center justify-between hover:border-gray-700 transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={18} className="text-gray-400" />
            <span className="text-sm font-medium text-white">压缩预设</span>
          </div>
          <span className="text-sm text-gray-500">{presetCount} 个预设</span>
        </button>
      </div>
    </div>
  );
}
