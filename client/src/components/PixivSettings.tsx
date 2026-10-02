import { useEffect, useState } from 'react';
import { fetchPixivSettings, updatePixivSettings } from '../api/pixiv';
import type { PixivSettings as Settings } from '../../../shared/types';
import { PixivIcon } from './ImportSources';

export default function PixivSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { void fetchPixivSettings().then(setSettings).catch(() => setMessage('无法读取 Pixiv 配置')); }, []);
  const save = async (value: string) => {
    setBusy(true); setMessage('');
    try { setSettings(await updatePixivSettings(value)); setToken(''); setMessage(value ? '已保存' : '已清除'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <section className="bg-gray-900 rounded-xl p-4 border border-gray-800">
    <div className="flex items-center gap-2 mb-3"><PixivIcon className="w-5 h-5" /><h3 className="text-sm font-medium text-white">Pixiv 登录</h3>
      <span className="ml-auto text-xs text-gray-500">{settings ? settings.configured ? '已配置' : '未配置' : '读取中…'}</span>
    </div>
    <form onSubmit={event => { event.preventDefault(); void save(token.trim()); }}>
      <label className="block text-sm text-gray-400">Refresh token
        <input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} maxLength={8192}
          placeholder={settings?.configured ? '输入新 token 以替换' : '粘贴 gallery-dl 获取的 refresh-token'}
          className="mt-2 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white" />
      </label>
      <p className="text-xs text-gray-500 mt-2">使用 <code>gallery-dl oauth:pixiv</code> 获取，仅保存在当前服务器。</p>
      <div className="flex items-center gap-3 mt-3">
        <button disabled={busy || !token.trim()} className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm disabled:opacity-50">保存</button>
        {settings?.configured && <button type="button" disabled={busy} onClick={() => void save('')} className="text-sm text-gray-400 disabled:opacity-50">清除登录态</button>}
        <span role="status" className="text-xs text-gray-400">{message}</span>
      </div>
    </form>
  </section>;
}
