import { useEffect, useRef, useState, type ReactNode, type ComponentType } from 'react';
import { Loader2, X } from 'lucide-react';
import type { BrowserLoginSession } from '../../../shared/types';
import { ActionRow, Button, IconButton, TextButton } from './Button';
import BrowserLogin, { type BrowserLoginCopy } from './BrowserLogin';
import { showError, showSuccess, showWarning } from './Toast';
import { createPortal } from 'react-dom';
import Modal from './Modal';

export interface LoginSettingsState {
  configured: boolean;
  browserLoginEnabled?: boolean;
  credential: string;
  readOnly?: boolean;
}
export interface SettingsFormProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  readOnly?: boolean;
}
export interface ExternalSettingsCopy {
  title: string;
  configured: string;
  close: string;
  loading: string;
  manual: string;
  browser: BrowserLoginCopy;
  clear: string;
  cancel: string;
  save: string;
  saving: string;
  loginSuccess: string;
  saveSuccess: string;
  clearSuccess: string;
  loadError: string;
  loginError: string;
  saveError: string;
  sessionEnded: string;
  popupBlocked: string;
}
export const externalSettingsCopy = {
  configured: '已登录', close: '关闭', loading: '读取配置中', manual: '手动输入',
  clear: '清除登录态', cancel: '取消', save: '保存', saving: '保存中…', clearSuccess: '已清除登录态',
  loadError: '无法读取登录配置', loginError: '浏览器登录失败', saveError: '保存失败',
  sessionEnded: '登录会话已结束，请重新打开', popupBlocked: '浏览器拦截了弹窗，请点击「打开浏览器」',
};
export interface ExternalSettingsConfig {
  copy: ExternalSettingsCopy;
  icon?: ReactNode;
  preview?: ReactNode;
  Form: ComponentType<SettingsFormProps>;
  load: () => Promise<LoginSettingsState>;
  save: (credential: string) => Promise<LoginSettingsState>;
  browser: {
    get: () => Promise<{ session: BrowserLoginSession | null; error?: string }>;
    start: (mobile: boolean) => Promise<BrowserLoginSession>;
    complete: (id: string) => Promise<unknown>;
    cancel: (id: string) => Promise<unknown>;
  };
}
export interface SettingsDialogProps { onClose: () => void; onSaved?: () => void }

export default function ExternalSettingsDialog({ copy, icon, preview, Form, load, save: saveSettings, browser, onClose, onSaved }: SettingsDialogProps & ExternalSettingsConfig) {
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
    showSuccess(copy.loginSuccess); callbacks.current.onSaved?.(); callbacks.current.onClose();
  };
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void (async () => {
      const info = await load();
      if (!active) return;
      setSettings(info);
      const credential = info.credential;
      setValue(credential); setSaved(credential);
      if (!info.browserLoginEnabled || info.readOnly) setMode('manual');
      if (info.browserLoginEnabled) {
        const current = await browser.get();
        if (active && current.session && !current.session.completed) setSession(current.session);
      }
    })().catch(error => { if (active) showError(error instanceof Error ? error.message : copy.loadError); });
    return () => { active = false; mounted.current = false; };
  }, [load, browser]);
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
          setSession(null); popup.current?.close(); showWarning(copy.sessionEnded);
        } else if (result.error && result.error !== lastError) { lastError = result.error; showError(result.error); }
      } catch { /* A transient local connection error should not discard the session. */ }
      finally { pending = false; }
    };
    const timer = setInterval(() => void refreshSession(), 1000);
    window.addEventListener('focus', refreshSession);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refreshSession); };
  }, [session, browser]);
  const open = (current: BrowserLoginSession) => {
    const mobile = window.matchMedia('(max-width: 640px)').matches;
    popup.current = window.open(current.browserUrl, 'aoi-browser-login', `popup,width=${mobile ? 430 : 1100},height=${mobile ? 880 : 820}`);
    if (popup.current) { popup.current.opener = null; popup.current.focus(); }
    else showWarning(copy.popupBlocked);
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
    } catch (error) { showError(error instanceof Error ? error.message : copy.loginError); }
    finally { setBusy(false); }
  };
  const save = async (credential: string) => {
    setBusy(true);
    try {
      const next = await saveSettings(credential);
      setSettings(next); setValue(credential); setSaved(credential);
      showSuccess(credential ? copy.saveSuccess : copy.clearSuccess);
      if (credential) { onSaved?.(); onClose(); }
    } catch (error) { showError(error instanceof Error ? error.message : copy.saveError); }
    finally { setBusy(false); }
  };
  return createPortal(<Modal visible onClose={onClose} className="!max-w-lg">
    <div role="dialog" aria-modal="true" aria-label={copy.title}>
      <section className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-2">
          {icon}<h3 className="text-base font-medium text-white">{copy.title}</h3>
          {settings?.configured && <span className="rounded-md border border-green-500/25 bg-green-500/10 px-2 py-0.5 text-xs text-green-400">{copy.configured}</span>}
          <IconButton label={copy.close} icon={<X size={16} />} disabled={busy} onClick={onClose} className="ml-auto" />
        </div>
        {!settings ? <div className="flex justify-center py-10" role="status"><Loader2 className="animate-spin text-gray-400" aria-label={copy.loading} /></div>
          : session || mode === 'browser' && browserEnabled ? <>
            <BrowserLogin active={Boolean(session)} busy={busy} copy={copy.browser} preview={preview}
              onStart={() => void action('start')} onOpen={() => { if (session) open(session); }}
              onCancel={() => void action('cancel')} onComplete={() => void action('complete')} />
            {!session && <TextButton disabled={busy} className="mt-4 text-sm" onClick={() => setMode('manual')}>{copy.manual}</TextButton>}
          </> : <form onSubmit={event => { event.preventDefault(); if (!readOnly && !busy && value.trim() && value.trim() !== saved) void save(value.trim()); }}>
            <Form value={value} onChange={setValue} disabled={busy} readOnly={readOnly} />
            {browserEnabled && <TextButton disabled={busy} className="mt-4 text-sm" onClick={() => setMode('browser')}>{copy.browser.title}</TextButton>}
            <ActionRow className="mt-5">
              <Button disabled={busy} onClick={settings.configured && !readOnly ? () => void save('') : onClose}>{settings.configured && !readOnly ? copy.clear : copy.cancel}</Button>
              {!readOnly && <Button type="submit" variant="primary" disabled={busy || !value.trim() || value.trim() === saved}>{busy ? copy.saving : copy.save}</Button>}
            </ActionRow>
          </form>}
      </section>
    </div>
  </Modal>, document.body);
}
