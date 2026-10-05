import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import type { MegaSettings } from '../../../shared/types';
import { fetchMegaSettings, loginMega, logoutMega } from '../api/mega';
import { ActionRow, Button, IconButton } from './Button';
import { FormField, TextInput } from './Form';
import { MegaIcon } from './ImportSources';
import Modal from './Modal';
import { showError, showSuccess } from './Toast';
import type { SettingsDialogProps } from './ExternalSettingsDialog';

export default function MegaSettingsDialog({ onClose, onSaved }: SettingsDialogProps) {
  const [settings, setSettings] = useState<MegaSettings | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchMegaSettings().then(value => { if (active) setSettings(value); }).catch(error => {
      if (active) { setLoadError(true); showError(error instanceof Error ? error.message : '无法读取 MEGA 配置'); }
    });
    return () => { active = false; };
  }, []);
  const save = async (clear = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = clear ? await logoutMega() : await loginMega({ email, password, ...(code ? { secondFactorCode: code } : {}) });
      setSettings(next); setPassword(''); setCode('');
      showSuccess(clear ? '已清除 MEGA 登录态' : 'MEGA 登录成功');
      onSaved?.(); onClose();
    } catch (error) { showError(error instanceof Error ? error.message : 'MEGA 登录失败'); }
    finally { setBusy(false); }
  };
  return createPortal(<Modal visible onClose={busy ? () => {} : onClose} className="!max-w-lg">
    <div role="dialog" aria-modal="true" aria-label="MEGA 配置" className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6">
      <div className="mb-5 flex items-center gap-2">
        <MegaIcon className="h-6 w-6" /><h3 className="text-base font-medium text-white">MEGA 配置</h3>
        {settings?.configured && <span className={`rounded-md border px-2 py-0.5 text-xs ${settings.expired ? 'border-amber-500/25 bg-amber-500/10 text-amber-400' : 'border-green-500/25 bg-green-500/10 text-green-400'}`}>{settings.expired ? '已失效' : '已登录'}</span>}
        <IconButton label="关闭" icon={<X size={16} />} disabled={busy} onClick={onClose} className="ml-auto" />
      </div>
      {!settings ? <div role="status" className="flex justify-center py-10">{loadError ? <p className="text-sm text-gray-400">无法读取配置，请关闭后重试。</p> : <Loader2 className="animate-spin text-gray-400" aria-label="读取配置中" />}</div>
        : <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <div className="flex flex-col gap-3">
            <FormField label="邮箱"><TextInput type="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></FormField>
            <FormField label="密码"><TextInput type="password" autoComplete="current-password" required maxLength={1024} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></FormField>
            <FormField label="二次验证码（如已启用）"><TextInput inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} disabled={busy} onChange={event => setCode(event.target.value)} /></FormField>
          </div>
          <p className="mt-3 text-xs leading-5 text-gray-500">登录可选。仅保存导入所需的会话，不保存密码或验证码。下载额度由 MEGA 决定。</p>
          <ActionRow className="mt-5">
            <Button disabled={busy} onClick={settings.configured ? () => void save(true) : onClose}>{settings.configured ? '清除登录态' : '取消'}</Button>
            <Button type="submit" variant="primary" disabled={busy || !email.trim() || !password}>{busy ? '处理中…' : '登录'}</Button>
          </ActionRow>
        </form>}
    </div>
  </Modal>, document.body);
}
