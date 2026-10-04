import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { BrowserLoginProvider, BrowserLoginSession } from '../../../shared/types';
import { fetchPixivSettings, updatePixivSettings } from '../api/pixiv';
import { fetchFanboxSettings, updateFanboxSettings } from '../api/fanbox';
import { getBrowserLogin, startBrowserLogin, completeBrowserLogin, cancelBrowserLogin } from '../api/browser-login';
import { PixivIcon, FanboxIcon } from './ImportSources';
import { ActionRow, Button, IconButton, TextButton } from './Button';
import { FormField, TextInput } from './Form';
import { showError, showSuccess, showWarning } from './Toast';
import loginPreview from '../assets/pixiv-login.png';

type Settings = { configured: boolean; browserLoginEnabled?: boolean; source: string };
export default function ExternalLoginSettings({ provider, onClose, onSaved }: {
  provider: BrowserLoginProvider; onClose: () => void; onSaved?: () => void;
}) {
  const name = provider === 'pixiv' ? 'Pixiv' : 'FANBOX';
  const Icon = provider === 'pixiv' ? PixivIcon : FanboxIcon;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<'browser' | 'manual'>('browser');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<BrowserLoginSession | null>(null);
  const completed = useRef(false);
  const mounted = useRef(true);
  const popup = useRef<Window | null>(null);
  const callbacks = useRef({ onSaved, onClose }); callbacks.current = { onSaved, onClose };
  const fileManaged = settings?.source === 'cookie_file';
  const browserEnabled = Boolean(settings?.browserLoginEnabled && !fileManaged);
  const finish = () => {
    if (completed.current) return;
    completed.current = true; popup.current?.close();
    showSuccess(`${name} 登录成功`); callbacks.current.onSaved?.(); callbacks.current.onClose();
  };
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void (async () => {
      const info = provider === 'pixiv' ? await fetchPixivSettings(true) : await fetchFanboxSettings(true);
      if (!active) return;
      setSettings(info);
      const credential = 'refreshToken' in info ? info.refreshToken ?? '' : 'sessionId' in info ? info.sessionId ?? '' : '';
      setValue(credential); setSaved(credential);
      if (!info.browserLoginEnabled || info.source === 'cookie_file') setMode('manual');
      if (info.browserLoginEnabled) {
        const current = await getBrowserLogin(provider);
        if (active && current.session && !current.session.completed) setSession(current.session);
      }
    })().catch(error => { if (active) showError(error instanceof Error ? error.message : '无法读取登录配置'); });
    return () => { active = false; mounted.current = false; };
  }, [provider]);
  useEffect(() => {
    if (!session) return;
    let active = true; let pending = false; let lastError = '';
    const refreshSession = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await getBrowserLogin(provider);
        if (!active) return;
        if (result.session?.id === session.id && result.session.completed) { finish(); return; }
        if (!result.session || result.session.id !== session.id || Date.parse(session.expiresAt) <= Date.now()) {
          setSession(null); popup.current?.close(); showWarning('登录会话已结束，请重新打开');
        } else if (result.error && result.error !== lastError) { lastError = result.error; showError(result.error); }
      } catch { /* A transient local connection error should not discard the session. */ }
      finally { pending = false; }
    };
    const timer = setInterval(() => void refreshSession(), 1000);
    window.addEventListener('focus', refreshSession);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refreshSession); };
  }, [session, provider]);
  const open = (current: BrowserLoginSession) => {
    const mobile = window.matchMedia('(max-width: 640px)').matches;
    popup.current = window.open(current.browserUrl, 'aoi-browser-login', `popup,width=${mobile ? 430 : 1100},height=${mobile ? 880 : 820}`);
    if (popup.current) { popup.current.opener = null; popup.current.focus(); }
    else showWarning('浏览器拦截了弹窗，请点击「打开浏览器」');
  };
  const action = async (kind: 'start' | 'complete' | 'cancel') => {
    if (busy) return;
    setBusy(true);
    try {
      if (kind === 'start') {
        completed.current = false;
        const current = await startBrowserLogin(provider, window.matchMedia('(max-width: 640px)').matches);
        if (!mounted.current) { await cancelBrowserLogin(provider, current.id); return; }
        setSession(current); open(current);
      } else if (kind === 'complete' && session) {
        await completeBrowserLogin(provider, session.id); finish();
      } else if (session) {
        await cancelBrowserLogin(provider, session.id); popup.current?.close(); setSession(null);
      }
    } catch (error) { showError(error instanceof Error ? error.message : '浏览器登录失败'); }
    finally { setBusy(false); }
  };
  const save = async (credential: string) => {
    setBusy(true);
    try {
      const next = provider === 'pixiv' ? await updatePixivSettings(credential) : await updateFanboxSettings(credential);
      setSettings(next); setValue(credential); setSaved(credential);
      showSuccess(credential ? `${name} 登录配置已保存` : '已清除登录态');
      if (credential) { onSaved?.(); onClose(); }
    } catch (error) { showError(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <section className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6">
    <div className="mb-5 flex items-center gap-2">
      <Icon className="h-6 w-6" /><h3 className="text-base font-medium text-white">{name} 配置</h3>
      {settings?.configured && <span className="rounded-md border border-green-500/25 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">已登录</span>}
      <IconButton label="关闭" icon={<X size={16} />} disabled={busy} onClick={onClose} className="ml-auto" />
    </div>
    {!settings ? <div className="flex justify-center py-10" role="status"><Loader2 className="animate-spin text-gray-400" aria-label="读取配置中" /></div> : session ? <div className="space-y-5">
      <p className="text-sm leading-6 text-gray-300">完成 {name} 官方登录后将自动保存并关闭窗口。如未自动完成，可点击「我已登录」。</p>
      <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-2">
        <TextButton className="shrink-0 whitespace-nowrap text-sm" disabled={busy} onClick={() => open(session)}>打开浏览器</TextButton>
        <div className="flex shrink-0 gap-2">
          <Button className="w-28 shrink-0 whitespace-nowrap" disabled={busy} onClick={() => void action('cancel')}>取消登录</Button>
          <Button className="w-28 shrink-0 whitespace-nowrap" variant="primary" disabled={busy} onClick={() => void action('complete')}>{busy ? '正在验证…' : '我已登录'}</Button>
        </div>
      </div>
    </div> : mode === 'browser' && browserEnabled ? <div>
      <button type="button" disabled={busy} onClick={() => void action('start')} className="group relative flex min-h-40 w-full items-center justify-between gap-3 overflow-hidden rounded-xl border border-gray-700 bg-gray-800/60 text-left transition-colors hover:border-blue-500/60 hover:bg-gray-800 disabled:cursor-wait">
        <span className="relative z-10 flex-1 pl-5 py-5">
          <span className="flex items-center gap-2 text-base font-medium text-white">{busy && <Loader2 size={18} className="animate-spin" />}{busy ? '正在准备浏览器…' : '浏览器登录'}</span>
          <span className="mt-2 block text-xs leading-5 text-gray-400">完成官方登录，自动保存登录态</span>
        </span>
        <img src={loginPreview} alt="官方登录页面预览" className="mr-3 h-36 w-28 shrink-0 rounded-lg border border-white/10 object-cover object-top shadow-lg sm:w-36" />
      </button>
      <TextButton disabled={busy} className="mt-4 text-sm" onClick={() => setMode('manual')}>手动输入</TextButton>
    </div> : <form onSubmit={event => { event.preventDefault(); if (value.trim() && value.trim() !== saved) void save(value.trim()); }}>
      {fileManaged ? <p className="text-sm text-gray-400">登录态由服务端 Cookie 文件管理，请更新该文件。</p> : <>
        <FormField label={provider === 'pixiv' ? 'Refresh token' : 'FANBOXSESSID'}>
          <TextInput type="text" autoComplete="off" spellCheck={false} disabled={busy} value={value} onChange={event => setValue(event.target.value)} maxLength={8192}
            placeholder={provider === 'pixiv' ? '粘贴 refresh token' : '粘贴 FANBOXSESSID 的值'} />
        </FormField>
        <p className="mt-2 text-xs leading-5 text-gray-500">{provider === 'pixiv' ? <>使用 <code>gallery-dl oauth:pixiv</code> 获取，仅保存在当前服务器。</> : '在已登录 FANBOX 的浏览器中，打开开发者工具 → Application / 存储 → Cookies，复制 FANBOXSESSID 的值。'}</p>
        {provider === 'fanbox' && <p className="mt-2 text-xs leading-5 text-gray-500">会话失效后需要重新登录；付费帖子需要相应访问权限。</p>}
      </>}
      {browserEnabled && <TextButton disabled={busy} className="mt-4 text-sm" onClick={() => setMode('browser')}>浏览器登录</TextButton>}
      <ActionRow className="mt-5">
        <Button disabled={busy} onClick={settings.configured && !fileManaged ? () => void save('') : onClose}>{settings.configured && !fileManaged ? '清除登录态' : '取消'}</Button>
        {!fileManaged && <Button type="submit" variant="primary" disabled={busy || !value.trim() || value.trim() === saved}>{busy ? '保存中…' : '保存'}</Button>}
      </ActionRow>
    </form>}
  </section>;
}
