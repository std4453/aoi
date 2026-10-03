import { useEffect, useState } from 'react';
import { fetchPixivSettings, updatePixivSettings } from '../api/pixiv';
import type { PixivSettings as Settings } from '../../../shared/types';
import { PixivIcon } from './ImportSources';
import { FormField, TextInput } from './Form';
import { X } from 'lucide-react';
import { ActionRow, Button, IconButton } from './Button';

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
      <IconButton label="关闭" icon={<X size={16} />} disabled={busy} onClick={onClose} className="ml-auto" />
    </div>
    <form onSubmit={event => { event.preventDefault(); if (canSave) void save(token.trim()); }}>
      <FormField label="Refresh token">
        <TextInput type="text" autoComplete="off" spellCheck={false} disabled={!settings || busy} value={token} onChange={event => setToken(event.target.value)} maxLength={8192}
          placeholder="粘贴 gallery-dl 获取的 refresh-token" />
      </FormField>
      <p className="text-xs text-gray-500 mt-2">使用 <code>gallery-dl oauth:pixiv</code> 获取，仅保存在当前服务器。</p>
      {message && <p role="status" className="mt-3 text-sm text-gray-300">{message}</p>}
      <ActionRow className="mt-4">
        <Button disabled={busy} onClick={settings?.configured ? () => void save('') : onClose}>{settings?.configured ? '清除登录态' : '取消'}</Button>
        <Button type="submit" variant="primary" disabled={!canSave}>{busy ? '保存中…' : '保存'}</Button>
      </ActionRow>
    </form>
  </section>;
}
