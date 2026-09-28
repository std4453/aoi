import { isPwa } from '../lib/pwa';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { ChevronRight, RefreshCw, Server, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { activeServer, CONNECTION_EVENT, connectionState, inspectServer, returnToServers, runtime, refreshRecoveredHome, saveServer, setConnectionState } from '../lib/connection';

export default function ConnectionStatus() {
  const [state, setState] = useState(connectionState);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [update, setUpdate] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    const changed = () => {
      setState(connectionState);
      if (connectionState !== 'offline') setDetailsOpen(false);
    };
    const unauthorized = () => {
      if (activeServer) saveServer({ ...activeServer, verified: false });
      sessionStorage.setItem('aoi.loginError', '登录已失效，请重新连接服务器');
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
    if (isPwa() && 'serviceWorker' in navigator) void navigator.serviceWorker.getRegistration().then(value => {
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
      {offline && (
        <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-40 pointer-events-none" role="status" aria-live="polite">
          <button
            type="button"
            aria-haspopup={recovered ? undefined : 'dialog'}
            onClick={() => recovered ? refreshRecoveredHome() : setDetailsOpen(true)}
            className={`pointer-events-auto flex items-center gap-2.5 w-max max-w-[90vw] rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-md ${recovered ? 'bg-blue-950/95 border-blue-700/50 text-blue-100' : 'bg-gray-800/95 border-gray-600/70 text-gray-200'}`}
          >
            {recovered ? <RefreshCw size={18} className="shrink-0 text-blue-400" /> : <WifiOff size={18} className="shrink-0 text-gray-400" />}
            <span>{recovered ? '连接已恢复' : '离线浏览中'}</span>
            {!recovered && <ChevronRight size={16} className="shrink-0 opacity-60" />}
          </button>
        </div>
      )}

      {update && (
        <div className={`fixed ${offline ? 'bottom-[calc(9rem+env(safe-area-inset-bottom))]' : 'bottom-[calc(5rem+env(safe-area-inset-bottom))]'} left-1/2 -translate-x-1/2 z-40`}>
          <button type="button" className="w-max max-w-[90vw] rounded-xl border border-blue-700/50 bg-blue-950/95 px-4 py-3 text-sm text-blue-100 shadow-lg" onClick={() => {
            navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
            update.postMessage({ type: 'activate' });
          }}>新版本已就绪，更新并刷新</button>
        </div>
      )}

      <Dialog open={detailsOpen && state === 'offline'} onClose={() => setDetailsOpen(false)} className="fixed inset-0 z-50">
        <div className="fixed inset-0 bg-black/60" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-900 p-5 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <WifiOff size={22} className="text-gray-400" />
              <DialogTitle className="flex-1 text-lg font-semibold text-white">
                暂时无法连接服务器
              </DialogTitle>
              <button type="button" aria-label="关闭连接提示" onClick={() => setDetailsOpen(false)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-gray-300 leading-relaxed">
              正在显示此前缓存的内容，未缓存的图片无法查看。上传、生成和删除等操作暂不可用。你可以尝试重新连接，或切换到其他服务器。
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
