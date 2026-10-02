import { useEffect, useState } from 'react';
import { fetchPixivSettings } from '../api/pixiv';
import ImportSources from './ImportSources';
import PixivSettings from './PixivSettings';
import Modal from './Modal';

export function PixivSettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  return <Modal visible onClose={onClose} className="max-w-lg">
    <div role="dialog" aria-modal="true" aria-label="Pixiv 配置">
      <PixivSettings onClose={onClose} onSaved={onSaved} />
    </div>
  </Modal>;
}

export default function ExternalSourcesSettings() {
  const [selected, setSelected] = useState(false);
  const [configured, setConfigured] = useState(false);
  const refresh = () => { void fetchPixivSettings().then(value => setConfigured(value.configured)).catch(() => setConfigured(false)); };
  useEffect(refresh, []);
  return <>
    <ImportSources card title="外部来源" configuredSources={configured ? ['pixiv'] : []} onSelect={() => setSelected(true)} />
    {selected && <PixivSettingsDialog onClose={() => setSelected(false)} onSaved={refresh} />}
  </>;
}
