export function PixivIcon({ className = 'w-10 h-10' }: { className?: string }) {
  // Pixiv mark from Simple Icons (CC0): https://simpleicons.org/?q=pixiv
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect width="24" height="24" rx="5" fill="white" />
    <path fill="#0096fa" d="M4.94 0A4.953 4.953 0 0 0 0 4.94v14.12A4.953 4.953 0 0 0 4.94 24h14.12A4.953 4.953 0 0 0 24 19.06c-.014 1.355 0-14.12 0-14.12A4.953 4.953 0 0 0 19.06 0Zm1.783 5.465h.904a.37.37 0 0 1 .31.17l.752 1.17a6.172 6.172 0 0 1 10.01 4.834 6.172 6.172 0 0 1-9.394 5.265v2.016a.37.37 0 0 1-.37.367H6.724a.37.37 0 0 1-.37-.367V5.834a.37.37 0 0 1 .37-.37m5.804 2.951a3.222 3.222 0 1 0-.002 6.443 3.222 3.222 0 0 0 .002-6.443" />
  </svg>;
}

// A provider descriptor keeps the layout independent of individual import forms.
const sources = [{ id: 'pixiv', label: 'Pixiv', Icon: PixivIcon }] as const;

export default function ImportSources({ onSelect, title = '导入自', card = false }: { onSelect: (source: typeof sources[number]['id']) => void; title?: string; card?: boolean }) {
  return <section className={card ? 'mt-3 bg-gray-900 rounded-xl p-4 border border-gray-800' : 'mt-6'} aria-label={title}>
    <h3 className={card ? 'text-sm font-medium text-white mb-3' : 'text-sm text-gray-500 mb-3'}>{title}</h3>
    <div className="flex flex-wrap gap-3">
      {sources.map(({ id, label, Icon }) => <button key={id} type="button" onClick={() => onSelect(id)}
        className="flex flex-col items-center gap-2 rounded-xl px-4 py-3 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors">
        <Icon /><span className="text-xs">{label}</span>
      </button>)}
    </div>
  </section>;
}
