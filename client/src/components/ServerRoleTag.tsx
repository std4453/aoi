import type { ServerHealth } from '../../../shared/types';

export default function ServerRoleTag({ role, writable }: Pick<ServerHealth, 'role' | 'writable'>) {
  if (role !== 'standalone' && role !== 'replica') {
    return writable === false ? <span className="shrink-0">（只读）</span> : null;
  }
  const primary = role === 'standalone';
  return (
    <span
      aria-label={primary ? '主服务器' : '备服务器'}
      className={`ml-2 shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${primary ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}
    >
      {primary ? '主' : '备'}
    </span>
  );
}
