import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { ChevronRight, RefreshCw, Server, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { activeServer, CONNECTION_EVENT, connectionState, inspectServer, returnToServers, runtime, saveServer, setConnectionState } from '../lib/connection';

export default function ConnectionStatus() {
  const [state, setState] = useState(connectionState);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  const offline = state !== 'online';
  const recovered = state === 'recovered';

  return (
    <>
      <div className="border-b border-gray-800 bg-gray-900 px-4 py-2 text-sm">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-3">
          <span className="text-gray-400 flex-1 truncate">{activeServer?.alias}</span>
          <button className="text-blue-400" onClick={returnToServers}>
            {runtime.serverSelectionEnabled ? '切换服务器' : '返回登录'}
          </button>
        </div>
        {update && <div className="max-w-4xl mx-auto mt-2 text-blue-300">新版本已就绪。<button className="underline" onClick={() => {
          navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
          update.postMessage({ type: 'activate' });
        }}>更新并刷新</button></div>}
      </div>

      {offline && (
        <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-40 pointer-events-none" role="status" aria-live="polite">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setDetailsOpen(true)}
            className={`pointer-events-auto flex items-center gap-2.5 w-max max-w-[90vw] rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-md ${recovered ? 'bg-blue-950/95 border-blue-700/50 text-blue-100' : 'bg-yellow-950/95 border-yellow-700/50 text-yellow-100'}`}
          >
            {recovered ? <RefreshCw size={18} className="shrink-0 text-blue-400" /> : <WifiOff size={18} className="shrink-0 text-yellow-400" />}
            <span>{recovered ? '连接已恢复，点击查看' : '正在离线浏览，点击查看'}</span>
            <ChevronRight size={16} className="shrink-0 opacity-60" />
          </button>
        </div>
      )}

      <Dialog open={detailsOpen && offline} onClose={() => setDetailsOpen(false)} className="fixed inset-0 z-50">
        <div className="fixed inset-0 bg-black/60" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-5 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              {recovered ? <RefreshCw size={22} className="text-blue-400" /> : <WifiOff size={22} className="text-yellow-400" />}
              <DialogTitle className="flex-1 text-lg font-semibold text-white">
                {recovered ? '服务器已恢复连接' : '暂时无法连接服务器'}
              </DialogTitle>
              <button type="button" aria-label="关闭连接提示" onClick={() => setDetailsOpen(false)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-gray-300 leading-relaxed">
              {recovered ? '当前浏览内容保持不变。你可以刷新以加载最新内容，或切换到其他服务器。' : '正在显示此前缓存的内容，未缓存的图片无法查看。上传、生成和删除等操作暂不可用。你可以尝试重新连接，或切换到其他服务器。'}
            </p>
            <p className="mt-3 text-xs text-gray-500 break-all">当前服务器：{activeServer?.alias}</p>
            <div className="mt-6 space-y-3">
              <button type="button" onClick={() => location.reload()} className="w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-medium text-white hover:bg-blue-500">
                <RefreshCw size={18} />重新连接并刷新
              </button>
              <button type="button" onClick={returnToServers} className="w-full flex items-center justify-center gap-2 rounded-xl bg-gray-800 py-3 text-sm text-gray-200 hover:bg-gray-700">
                <Server size={18} />{runtime.serverSelectionEnabled ? '切换服务器' : '返回登录'}
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  );
}
