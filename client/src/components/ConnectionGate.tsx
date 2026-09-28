import { useEffect, useState, type ReactNode } from 'react';
import type { ServerConnection } from '../../../shared/types';
import { clearServerCache, deleteServer, enterOffline, inspectServer, loadRuntime, login, LoginError, normalizeAddress, runtime, savedServers, saveServer } from '../lib/connection';

const blank = (): ServerConnection => ({ id: crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join(''), alias: '', address: '', key: '' });

export default function ConnectionGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [records, setRecords] = useState<ServerConnection[]>([]);
  const [draft, setDraft] = useState<ServerConnection>(blank);
  const [keyStep, setKeyStep] = useState(false);
  const [error, setError] = useState('');
  const [offlineAvailable, setOfflineAvailable] = useState(false);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        await loadRuntime();
        if (cancelled) return;
        setConfigured(true);
        const all = savedServers();
        setRecords(all);
        const current = runtime.serverSelectionEnabled
          ? all.find(item => item.id === localStorage.getItem('aoi.activeServer'))
          : all.find(item => item.id === 'same-origin') || { id: 'same-origin', alias: '当前服务器', address: location.origin, key: '' };
        const choose = sessionStorage.getItem('aoi.chooseServer');
        if (choose) sessionStorage.removeItem('aoi.chooseServer');
        if (current) {
          setDraft(current);
          if (!choose) {
            await connect(current, true, () => cancelled);
            return;
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '无法读取部署配置');
      }
      if (!cancelled) setBusy(false);
    }
    void start();
    return () => { cancelled = true; };
  }, []);

  async function connect(value: ServerConnection, automatic = false, cancelled = () => false) {
    setBusy(true);
    setError('');
    setOfflineAvailable(false);
    let server = value;
    try {
      server = { ...value, address: normalizeAddress(value.address), alias: value.alias.trim() || value.address };
      const old = savedServers().find(item => item.id === server.id);
      if (old && old.address !== server.address) {
        await clearServerCache(server.id);
        server.verified = false;
      }
      const health = await inspectServer(server.address);
      if (cancelled()) return;
      setDraft(server);
      if (health.authRequired && !automatic && !keyStep) {
        setKeyStep(true);
        return;
      }
      if (!health.authRequired) server.key = '';
      await login(server);
      if (!cancelled()) setReady(true);
    } catch (err) {
      if (cancelled()) return;
      if (err instanceof LoginError) {
        server.verified = false;
        saveServer(server);
        setKeyStep(true);
      }
      setDraft(server);
      const unreachable = err instanceof TypeError || (err instanceof DOMException && err.name === 'TimeoutError');
      setOfflineAvailable(Boolean(server.verified && unreachable));
      setError(unreachable
        ? '无法连接服务器。请检查地址、网络、证书信任和浏览器的局域网访问权限。'
        : err instanceof Error ? err.message : '连接失败');
    } finally {
      if (!cancelled()) setBusy(false);
    }
  }

  async function saveDraft() {
    setError('');
    try {
      const server = { ...draft, address: normalizeAddress(draft.address), alias: draft.alias.trim() || draft.address };
      const old = savedServers().find(item => item.id === server.id);
      if (old && old.address !== server.address) {
        await clearServerCache(server.id);
        server.verified = false;
      }
      saveServer(server);
      setDraft(server);
      setRecords(savedServers());
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
  }

  if (ready) return children;
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-6">
      <section className="w-full max-w-md space-y-6">
        <div><p className="text-blue-400 text-sm mb-2">AoI · 图包服务</p><h1 className="text-2xl font-bold">{runtime.serverSelectionEnabled ? '连接服务器' : '登录服务器'}</h1><p className="text-gray-400 text-sm mt-2">{keyStep ? '服务器已连接，请输入 Key' : '连接后浏览和管理你的图包'}</p></div>
        <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
          {runtime.serverSelectionEnabled && records.length > 0 && <div className="space-y-2">
            {records.filter(item => item.id !== 'same-origin').map(item => <div key={item.id} className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-900 p-3">
              <button className="flex-1 text-left min-w-0" onClick={() => { setDraft(item); setKeyStep(false); void connect(item, true); }}><span className="block font-medium truncate">{item.alias}</span><span className="block text-xs text-gray-400 truncate">{item.address}</span></button>
              <button className="text-sm text-blue-400" onClick={() => { setDraft(item); setKeyStep(false); setOfflineAvailable(false); setError(''); }}>编辑</button>
              <button className="text-sm text-gray-400" onClick={async () => { await deleteServer(item.id); setRecords(savedServers()); if (draft.id === item.id) setDraft(blank()); setOfflineAvailable(false); }}>删除</button>
            </div>)}
            <button className="text-sm text-blue-400" onClick={() => { setDraft(blank()); setKeyStep(false); setOfflineAvailable(false); setError(''); }}>＋ 添加服务器</button>
          </div>}
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); void connect(draft); }}>
            {runtime.serverSelectionEnabled && <>
              <label className="block text-sm">别名<input className="mt-2 w-full rounded-lg bg-gray-900 border border-gray-700 p-3" value={draft.alias} placeholder="例如：家里的服务器" onChange={e => setDraft({ ...draft, alias: e.target.value })} /></label>
              <label className="block text-sm">服务器地址<input required type="url" autoCapitalize="none" autoCorrect="off" className="mt-2 w-full rounded-lg bg-gray-900 border border-gray-700 p-3" value={draft.address} placeholder="https://aoi.example.com:8555" onChange={e => { setDraft({ ...draft, address: e.target.value, verified: false }); setKeyStep(false); setOfflineAvailable(false); }} /></label>
            </>}
            {keyStep && <label className="block text-sm">Key<input type="password" autoComplete="current-password" className="mt-2 w-full rounded-lg bg-gray-900 border border-gray-700 p-3" value={draft.key} onChange={e => setDraft({ ...draft, key: e.target.value })} /></label>}
            {runtime.serverSelectionEnabled && <button type="button" className="text-blue-400 text-sm" onClick={() => void saveDraft()}>保存服务器信息</button>}
            <button disabled={!configured} className="w-full rounded-lg bg-blue-600 py-3 font-medium">{busy ? '正在连接…' : keyStep ? '登录' : '连接服务器'}</button>
          </form>
        </fieldset>
        {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
        {!configured && !busy && <button className="text-blue-400" onClick={() => location.reload()}>重新加载</button>}
        {offlineAvailable && !busy && <button className="w-full border border-gray-700 rounded-lg py-3" onClick={() => { enterOffline(draft); setReady(true); }}>查看此服务器的离线缓存</button>}
      </section>
    </main>
  );
}
