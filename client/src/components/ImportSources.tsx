import { IconButton } from './Button';

export function PixivIcon({ className = 'w-10 h-10' }: { className?: string }) {
  // Pixiv mark from Simple Icons (CC0): https://simpleicons.org/?q=pixiv
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect width="24" height="24" rx="5" fill="white" />
    <path fill="#0096fa" d="M4.94 0A4.953 4.953 0 0 0 0 4.94v14.12A4.953 4.953 0 0 0 4.94 24h14.12A4.953 4.953 0 0 0 24 19.06c-.014 1.355 0-14.12 0-14.12A4.953 4.953 0 0 0 19.06 0Zm1.783 5.465h.904a.37.37 0 0 1 .31.17l.752 1.17a6.172 6.172 0 0 1 10.01 4.834 6.172 6.172 0 0 1-9.394 5.265v2.016a.37.37 0 0 1-.37.367H6.724a.37.37 0 0 1-.37-.367V5.834a.37.37 0 0 1 .37-.37m5.804 2.951a3.222 3.222 0 1 0-.002 6.443 3.222 3.222 0 0 0 .002-6.443" />
  </svg>;
}

export function MegaIcon({ className = 'w-10 h-10' }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#d9272e" /><path d="M5.5 16.5v-9H8l4 4.2 4-4.2h2.5v9H16v-5.4l-4 4-4-4v5.4z" fill="white" /></svg>;
}

const sources = [{ id: 'pixiv', label: 'Pixiv', Icon: PixivIcon }, { id: 'mega', label: 'MEGA', Icon: MegaIcon }] as const;
type Source = typeof sources[number]['id'];

export default function ImportSources({ onSelect, title = '导入自', card = false, compact = false, configuredSources = [], availableSources = ['pixiv'] }: { onSelect: (source: Source) => void; title?: string; card?: boolean; compact?: boolean; configuredSources?: readonly string[]; availableSources?: readonly Source[] }) {
  return <section className={compact ? 'mt-5 flex flex-wrap items-center justify-center gap-2' : card ? 'mt-3 bg-gray-900 rounded-xl p-4 border border-gray-800' : 'mt-6'} aria-label={title}>
    <h3 className={compact ? 'shrink-0 text-xs text-gray-500' : card ? 'text-sm font-medium text-white mb-3' : 'text-sm text-gray-500 mb-3'}>{title}</h3>
    <div className={compact ? 'flex flex-wrap gap-1' : 'flex flex-wrap gap-3'}>
      {sources.filter(source => availableSources.includes(source.id)).map(({ id, label, Icon }) => compact
        ? <IconButton key={id} icon={<Icon className="h-8 w-8" />} label={label} title={label} onClick={() => onSelect(id)} className="h-10 w-10" />
        : <div key={id} className="relative flex flex-col items-center gap-2 px-2 py-1">
          <IconButton icon={<Icon className="h-10 w-10" />} label={label} onClick={() => onSelect(id)} className="h-auto w-auto p-1" />
          <span className="text-xs text-gray-400">{label}</span>
          {configuredSources.includes(id) && <span aria-label="已配置" title="已配置" className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-[10px] text-white ring-2 ring-gray-900">✓</span>}
        </div>)}
    </div>
  </section>;
}
