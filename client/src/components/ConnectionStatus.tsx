import { ChevronRight, WifiOff } from 'lucide-react';
import { useConnectionState } from '../hooks/useConnectionState';
import { returnToServers } from '../lib/connection';

export default function ConnectionStatus() {
  const { status } = useConnectionState();
  if (status !== 'failed') return null;

  return (
    <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-40" role="status" aria-live="polite">
      <button
        type="button"
        onClick={returnToServers}
        className="flex items-center gap-2.5 w-max max-w-[90vw] rounded-xl border border-red-700/50 bg-red-950/95 px-4 py-3 text-sm text-red-100 shadow-lg backdrop-blur-md"
      >
        <WifiOff size={18} className="shrink-0 text-red-400" />
        <span>服务器连接失败</span>
        <ChevronRight size={16} className="shrink-0 opacity-60" />
      </button>
    </div>
  );
}
