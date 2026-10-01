import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import type { ServerConnection } from '../../../shared/types';
import { setServerCapabilities, deleteServer, inspectServer, loadRuntime, login, LoginError, normalizeAddress, runtime, savedServers } from '../lib/connection';
import { showError } from './Toast';

const blank = (): ServerConnection => ({
  id: crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join(''),
  alias: '',
  address: '',
  key: '',
});

export default function ConnectionGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [records, setRecords] = useState<ServerConnection[]>([]);
  const [draft, setDraft] = useState<ServerConnection>(blank);
  const [writableByAddress, setWritableByAddress] = useState<Record<string, boolean>>({});
  const [configured, setConfigured] = useState(false);
  const listPage = runtime.serverSelectionEnabled && location.pathname === '/servers';
  const editing = runtime.serverSelectionEnabled && location.pathname.startsWith('/servers/edit/');

  // Routes separate the list from the form and also support the browser's Back button.
  useEffect(() => {
    if (location.pathname === '/servers/new') {
      setDraft(blank());
    }
    if (location.pathname.startsWith('/servers/edit/')) {
      const id = location.pathname.slice('/servers/edit/'.length);
      const server = savedServers().find(item => item.id === id);
      if (server) setDraft(server);
      else navigate('/servers', { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        await loadRuntime();
        if (cancelled) return;
        setConfigured(true);
        const all = savedServers();
        const selectable = all.filter(item => item.id !== 'same-origin');
        setRecords(selectable);
        const current = runtime.serverSelectionEnabled
          ? selectable.find(item => item.id === localStorage.getItem('aoi.activeServer'))
          : all.find(item => item.id === 'same-origin') || { id: 'same-origin', alias: '当前服务器', address: window.location.origin, key: '' };
        const choose = sessionStorage.getItem('aoi.chooseServer');
        sessionStorage.removeItem('aoi.chooseServer');
        const loginError = sessionStorage.getItem('aoi.loginError');
        sessionStorage.removeItem('aoi.loginError');
        if (loginError) showError(loginError);
        if (current && !choose && !window.location.pathname.startsWith('/servers')) {
          setDraft(current);
          await connect(current, true, () => cancelled);
          return;
        }
        if (!runtime.serverSelectionEnabled && current) setDraft(current);
        if (runtime.serverSelectionEnabled && !window.location.pathname.startsWith('/servers')) {
          navigate(selectable.length ? '/servers' : '/servers/new', { replace: true });
        }
      } catch (error) {
        if (!cancelled) showError(error instanceof Error ? error.message : '无法读取部署配置');
      }
      if (!cancelled) setBusy(false);
    }
    void start();
    return () => { cancelled = true; };
  }, []);

  // Refresh labels without logging in or blocking selection. If a server is
  // offline, retain the capability saved by the last successful connection.
  useEffect(() => {
    if (!configured || !listPage || ready) return;
    let cancelled = false;
    void Promise.allSettled(records.map(async server => {
      const health = await inspectServer(server.address);
      if (!cancelled) setWritableByAddress(current => ({ ...current, [server.address]: health.writable !== false }));
    }));
    return () => { cancelled = true; };
  }, [configured, listPage, ready, records]);

  async function connect(value: ServerConnection, automatic = false, cancelled = () => false) {
    setBusy(true);
    setConnectingId(value.id);
    let server = value;
    const old = savedServers().find(item => item.id === value.id);
    try {
      server = { ...value, address: normalizeAddress(value.address), alias: value.alias.trim() || value.address };
      const health = await inspectServer(server.address);
      if (cancelled()) return;
      server.writable = health.writable !== false;
      if (!health.authRequired) server.key = '';
      await login(server);
      setServerCapabilities(health);
      if (!cancelled()) {
        if (!automatic || window.location.pathname.startsWith('/servers')) navigate('/', { replace: true });
        setReady(true);
      }
    } catch (error) {
      if (cancelled()) return;
      if (error instanceof LoginError) {
        if (old && old.address === server.address) {
          if (runtime.serverSelectionEnabled) navigate(`/servers/edit/${server.id}`, { replace: automatic });
        }
      } else if (automatic && runtime.serverSelectionEnabled) {
        navigate('/servers', { replace: true });
      }
      setDraft(server);
      const unreachable = error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
      showError(unreachable
        ? '无法连接服务器，请检查地址、网络或证书。'
        : error instanceof Error ? error.message : '连接失败');
    } finally {
      if (!cancelled()) {
        setBusy(false);
        setConnectingId(null);
      }
    }
  }

  async function remove(server: ServerConnection) {
    setBusy(true);
    try {
      await deleteServer(server.id);
      const remaining = savedServers().filter(item => item.id !== 'same-origin');
      setRecords(remaining);
      if (!remaining.length) navigate('/servers/new', { replace: true });
    } catch (error) {
      showError(error instanceof Error ? error.message : '删除失败，请重试');
    } finally { setBusy(false); }
  }

  if (ready) return children;
  if (!configured) {
    return <main className="min-h-screen flex items-center justify-center p-6">
      {busy ? <Loader2 className="animate-spin text-blue-400" aria-label="正在加载" /> : <button className="text-blue-400" onClick={() => window.location.reload()}>重新加载</button>}
    </main>;
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-6 py-8">
      <section className="w-full max-w-md">
        {!listPage && runtime.serverSelectionEnabled && (
          <button type="button" disabled={busy} onClick={() => navigate('/servers')} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-6">
            <ArrowLeft size={18} />返回服务器列表
          </button>
        )}
        <div className="mb-7">
          <p className="text-blue-400 text-sm mb-2">AoI · 图包服务</p>
          <h1 className="text-2xl font-bold">{listPage ? '切换服务器' : runtime.serverSelectionEnabled ? editing ? '编辑服务器' : '添加服务器' : '登录服务器'}</h1>
          <p className="text-gray-400 text-sm mt-2">{listPage ? '选择服务器即可连接' : '填写连接信息，开始浏览你的图包'}</p>
        </div>

        {listPage ? (
          <fieldset disabled={busy} className="space-y-3">
            {records.map(server => (
              <div key={server.id} className="flex items-center gap-1 rounded-xl border border-gray-800 bg-gray-900 p-2">
                <button type="button" onClick={() => void connect(server)} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left hover:bg-gray-800/50">
                  {connectingId === server.id ? <Loader2 size={20} className="shrink-0 animate-spin text-blue-400" /> : <Server size={20} className="shrink-0 text-gray-500" />}
                  <span className="min-w-0">
                    <span className="flex font-medium">
                      <span className="truncate">{server.alias}</span>
                      {(writableByAddress[server.address] ?? server.writable) === false && <span className="shrink-0">（只读）</span>}
                    </span>
                    <span className="block text-xs text-gray-500 truncate mt-1">{server.address}</span>
                  </span>
                </button>
                <button type="button" aria-label={`编辑 ${server.alias}`} title="编辑服务器" onClick={() => navigate(`/servers/edit/${server.id}`)} className="p-2.5 rounded-lg text-gray-400 hover:bg-gray-800 hover:text-white">
                  <Pencil size={17} />
                </button>
                <button type="button" aria-label={`删除 ${server.alias}`} title="删除服务器" onClick={() => void remove(server)} className="p-2.5 rounded-lg text-gray-500 hover:bg-gray-800 hover:text-red-400">
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
            {!records.length && <p className="text-sm text-gray-500 py-3">还没有保存的服务器</p>}
            <button type="button" onClick={() => navigate('/servers/new')} className="w-full flex items-center justify-center gap-2 rounded-xl border border-gray-700 py-4 text-sm text-gray-200 hover:bg-gray-900 hover:border-gray-500">
              <Plus size={19} />添加服务器
            </button>
          </fieldset>
        ) : (
          <form onSubmit={event => { event.preventDefault(); void connect(draft); }}>
            <fieldset disabled={busy} className="space-y-5">
              {runtime.serverSelectionEnabled && <>
                <label className="block text-sm">别名
                  <input className="mt-2 w-full rounded-xl bg-gray-900 border border-gray-700 p-3" value={draft.alias} placeholder="例如：家里的服务器" onChange={event => setDraft({ ...draft, alias: event.target.value })} />
                </label>
                <label className="block text-sm">服务器地址
                  <input required type="url" autoCapitalize="none" autoCorrect="off" className="mt-2 w-full rounded-xl bg-gray-900 border border-gray-700 p-3" value={draft.address} placeholder="https://aoi.example.com:8555" onChange={event => setDraft({ ...draft, address: event.target.value })} />
                </label>
              </>}
              <label className="block text-sm">Key
                <input type="password" autoComplete="current-password" className="mt-2 w-full rounded-xl bg-gray-900 border border-gray-700 p-3" value={draft.key} placeholder="未设置 Key 时可留空" onChange={event => setDraft({ ...draft, key: event.target.value })} />
              </label>
              <button type="submit" className="w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 font-medium text-white hover:bg-blue-500">
                {busy && <Loader2 size={18} className="animate-spin" />}
                {busy ? '正在连接…' : editing ? '保存并连接' : '连接服务器'}
              </button>
            </fieldset>
          </form>
        )}

      </section>
    </main>
  );
}
