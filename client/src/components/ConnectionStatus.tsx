import { useEffect, useState } from 'react';
import { activeServer, CONNECTION_EVENT, connectionState, inspectServer, returnToServers, runtime, saveServer, setConnectionState } from '../lib/connection';

export default function ConnectionStatus() {
  const [state, setState] = useState(connectionState);
  const [update, setUpdate] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    const changed = () => setState(connectionState);
    const unauthorized = () => {
      if (activeServer) saveServer({ ...activeServer, verified: false });
      returnToServers();
    };
    const message = (event: MessageEvent) => {
      if (event.data?.record !== activeServer?.id) return;
      if (event.data.type === 'offline' && connectionState === 'online') setConnectionState('offline');
      if (event.data.type === 'unauthorized') unauthorized();
    };
    window.addEventListener(CONNECTION_EVENT, changed);
    window.addEventListener('aoi:unauthorized', unauthorized);
    navigator.serviceWorker?.addEventListener('message', message);
    const check = async () => {
      if (!activeServer || document.visibilityState !== 'visible') return;
      try {
        await inspectServer(activeServer.address);
        if (connectionState === 'offline') setConnectionState('recovered');
      } catch {
        if (connectionState !== 'offline') setConnectionState('offline');
      }
    };
    const timer = setInterval(() => void check(), 15000);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    const found = () => {
      const installing = registration?.installing;
      installing?.addEventListener('statechange', () => {
        if (!disposed && installing.state === 'installed' && registration?.waiting) setUpdate(registration.waiting);
      });
    };
    if ('serviceWorker' in navigator) void navigator.serviceWorker.getRegistration().then(value => {
      if (disposed) return;
      registration = value;
      if (value?.waiting) setUpdate(value.waiting);
      value?.addEventListener('updatefound', found);
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener(CONNECTION_EVENT, changed);
      window.removeEventListener('aoi:unauthorized', unauthorized);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
      navigator.serviceWorker?.removeEventListener('message', message);
      registration?.removeEventListener('updatefound', found);
    };
  }, []);
  return <div className="border-b border-gray-800 bg-gray-900 px-4 py-2 text-sm">
    <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-3">
      <span className="text-gray-400 flex-1 truncate">{activeServer?.alias}</span>
      <button className="text-blue-400" onClick={returnToServers}>{runtime.serverSelectionEnabled ? '切换服务器' : '返回登录'}</button>
    </div>
    {state !== 'online' && <div className="max-w-4xl mx-auto mt-2 text-amber-300" role="status">{state === 'offline' ? '服务器不可达，正在显示缓存内容；未缓存的内容无法查看。' : '服务器已恢复连接。当前内容保持不变。'} <button className="underline" onClick={() => location.reload()}>重新连接并刷新</button></div>}
    {update && <div className="max-w-4xl mx-auto mt-2 text-blue-300">新版本已就绪。<button className="underline" onClick={() => {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      update.postMessage({ type: 'activate' });
    }}>更新并刷新</button></div>}
  </div>;
}
