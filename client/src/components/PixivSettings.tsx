import { useEffect, useState } from 'react';
import { fetchPixivSettings, updatePixivSettings } from '../api/pixiv';
import type { PixivSettings as Settings } from '../../../shared/types';
import { PixivIcon } from './ImportSources';

export default function PixivSettings({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [token, setToken] = useState('');
  const [savedToken, setSavedToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void fetchPixivSettings(true).then(value => {
      setSettings(value); setToken(value.refreshToken ?? ''); setSavedToken(value.refreshToken ?? '');
    }).catch(() => setMessage('无法读取 Pixiv 配置，请关闭后重试'));
  }, []);
  const canSave = settings !== null && !busy && !!token.trim() && token.trim() !== savedToken;
  const save = async (value: string) => {
    setBusy(true); setMessage('');
    try {
      setSettings(await updatePixivSettings(value)); setToken(value); setSavedToken(value);
      onSaved?.();
      if (value) onClose(); else setMessage('已清除登录态');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <section className="p-5">
    <div className="flex items-center gap-2 mb-4"><PixivIcon className="w-6 h-6" /><h3 className="text-base font-medium text-white">Pixiv 配置</h3>
      <button type="button" aria-label="关闭" disabled={busy} onClick={onClose} className="ml-auto rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-800 disabled:opacity-50">✕</button>
    </div>
    <form onSubmit={event => { event.preventDefault(); if (canSave) void save(token.trim()); }}>
      <label className="block text-sm text-gray-400">Refresh token
        <input type="text" autoComplete="off" spellCheck={false} disabled={!settings || busy} value={token} onChange={event => setToken(event.target.value)} maxLength={8192}
          placeholder="粘贴 gallery-dl 获取的 refresh-token"
          className="mt-2 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" />
      </label>
      <p className="text-xs text-gray-500 mt-2">使用 <code>gallery-dl oauth:pixiv</code> 获取，仅保存在当前服务器。</p>
      {message && <p role="status" className="mt-3 text-sm text-gray-300">{message}</p>}
      <div className="flex items-center justify-end gap-3 mt-5">
        {settings?.configured && <button type="button" disabled={busy} onClick={() => void save('')} className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm disabled:opacity-50">清除登录态</button>}
        <button disabled={!canSave} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed">{busy ? '保存中…' : '保存'}</button>
      </div>
    </form>
  </section>;
}
