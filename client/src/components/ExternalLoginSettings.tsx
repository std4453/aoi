import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import type { BrowserLoginSession } from '../../../shared/types';
import { ActionRow, Button, IconButton, TextButton } from './Button';
import { FormField, TextInput } from './Form';
import { showError, showSuccess, showWarning } from './Toast';
import { createPortal } from 'react-dom';
import Modal from './Modal';

export interface LoginSettingsState {
  configured: boolean;
  browserLoginEnabled?: boolean;
  credential: string;
  readOnly?: boolean;
}
export interface LoginSettingsAdapter {
  name: string;
  icon: ReactNode;
  preview: string;
  credentialLabel: string;
  credentialPlaceholder: string;
  instructions: ReactNode;
  sessionInstructions: string;
  loginSuccess: string;
  saveSuccess: string;
  readOnlyMessage?: string;
  load: () => Promise<LoginSettingsState>;
  save: (credential: string) => Promise<LoginSettingsState>;
  browser: {
    get: () => Promise<{ session: BrowserLoginSession | null; error?: string }>;
    start: (mobile: boolean) => Promise<BrowserLoginSession>;
    complete: (id: string) => Promise<unknown>;
    cancel: (id: string) => Promise<unknown>;
  };
}
export interface LoginSettingsProps { onClose: () => void; onSaved?: () => void }

export default function ExternalLoginSettings({ adapter, onClose, onSaved }: LoginSettingsProps & { adapter: LoginSettingsAdapter }) {
  const { name, browser } = adapter;
  const [settings, setSettings] = useState<LoginSettingsState | null>(null);
  const [mode, setMode] = useState<'browser' | 'manual'>('browser');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<BrowserLoginSession | null>(null);
  const completed = useRef(false);
  const mounted = useRef(true);
  const popup = useRef<Window | null>(null);
  const callbacks = useRef({ onSaved, onClose }); callbacks.current = { onSaved, onClose };
  const readOnly = settings?.readOnly;
  const browserEnabled = Boolean(settings?.browserLoginEnabled && !readOnly);
  const finish = () => {
    if (completed.current) return;
    completed.current = true; popup.current?.close();
    showSuccess(adapter.loginSuccess); callbacks.current.onSaved?.(); callbacks.current.onClose();
  };
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void (async () => {
      const info = await adapter.load();
      if (!active) return;
      setSettings(info);
      const credential = info.credential;
      setValue(credential); setSaved(credential);
      if (!info.browserLoginEnabled || info.readOnly) setMode('manual');
      if (info.browserLoginEnabled) {
        const current = await browser.get();
        if (active && current.session && !current.session.completed) setSession(current.session);
      }
    })().catch(error => { if (active) showError(error instanceof Error ? error.message : '无法读取登录配置'); });
    return () => { active = false; mounted.current = false; };
  }, [adapter]);
  useEffect(() => {
    if (!session) return;
    let active = true; let pending = false; let lastError = '';
    const refreshSession = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await browser.get();
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
  }, [session, adapter]);
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
        const current = await browser.start(window.matchMedia('(max-width: 640px)').matches);
        if (!mounted.current) { await browser.cancel(current.id); return; }
        setSession(current); open(current);
      } else if (kind === 'complete' && session) {
        await browser.complete(session.id); finish();
      } else if (session) {
        await browser.cancel(session.id); popup.current?.close(); setSession(null);
      }
    } catch (error) { showError(error instanceof Error ? error.message : '浏览器登录失败'); }
    finally { setBusy(false); }
  };
  const save = async (credential: string) => {
    setBusy(true);
    try {
      const next = await adapter.save(credential);
      setSettings(next); setValue(credential); setSaved(credential);
      showSuccess(credential ? adapter.saveSuccess : '已清除登录态');
      if (credential) { onSaved?.(); onClose(); }
    } catch (error) { showError(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return createPortal(<Modal visible onClose={onClose} className="!max-w-lg">
    <div role="dialog" aria-modal="true" aria-label={`${name} 配置`}>
    <section className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6">
    <div className="mb-5 flex items-center gap-2">
      {adapter.icon}<h3 className="text-base font-medium text-white">{name} 配置</h3>
      {settings?.configured && <span className="rounded-md border border-green-500/25 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">已登录</span>}
      <IconButton label="关闭" icon={<X size={16} />} disabled={busy} onClick={onClose} className="ml-auto" />
    </div>
    {!settings ? <div className="flex justify-center py-10" role="status"><Loader2 className="animate-spin text-gray-400" aria-label="读取配置中" /></div> : session ? <div className="space-y-5">
      <p className="text-sm leading-6 text-gray-300">{adapter.sessionInstructions}</p>
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
        <img src={adapter.preview} alt="官方登录页面预览" className="mr-3 h-36 w-28 shrink-0 rounded-lg border border-white/10 object-cover object-top shadow-lg sm:w-36" />
      </button>
      <TextButton disabled={busy} className="mt-4 text-sm" onClick={() => setMode('manual')}>手动输入</TextButton>
    </div> : <form onSubmit={event => { event.preventDefault(); if (value.trim() && value.trim() !== saved) void save(value.trim()); }}>
      {readOnly ? <p className="text-sm text-gray-400">{adapter.readOnlyMessage}</p> : <>
        <FormField label={adapter.credentialLabel}>
          <TextInput type="text" autoComplete="off" spellCheck={false} disabled={busy} value={value} onChange={event => setValue(event.target.value)} maxLength={8192}
            placeholder={adapter.credentialPlaceholder} />
        </FormField>
        {adapter.instructions}
      </>}
      {browserEnabled && <TextButton disabled={busy} className="mt-4 text-sm" onClick={() => setMode('browser')}>浏览器登录</TextButton>}
      <ActionRow className="mt-5">
        <Button disabled={busy} onClick={settings.configured && !readOnly ? () => void save('') : onClose}>{settings.configured && !readOnly ? '清除登录态' : '取消'}</Button>
        {!readOnly && <Button type="submit" variant="primary" disabled={busy || !value.trim() || value.trim() === saved}>{busy ? '保存中…' : '保存'}</Button>}
      </ActionRow>
    </form>}
  </section></div></Modal>, document.body);
}
