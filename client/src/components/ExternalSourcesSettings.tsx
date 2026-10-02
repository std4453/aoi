import { useState } from 'react';
import ImportSources from './ImportSources';
import PixivSettings from './PixivSettings';
import Modal from './Modal';

export function PixivSettingsDialog({ onClose }: { onClose: () => void }) {
  return <Modal visible onClose={onClose} className="max-w-lg">
    <div role="dialog" aria-modal="true" aria-label="Pixiv 配置">
      <PixivSettings />
      <div className="px-4 pb-4"><button type="button" onClick={onClose} className="w-full rounded-xl bg-gray-800 py-2.5 text-sm text-gray-300">完成</button></div>
    </div>
  </Modal>;
}

export default function ExternalSourcesSettings() {
  const [selected, setSelected] = useState(false);
  return <>
    <ImportSources title="外部来源" onSelect={() => setSelected(true)} />
    {selected && <PixivSettingsDialog onClose={() => setSelected(false)} />}
  </>;
}
