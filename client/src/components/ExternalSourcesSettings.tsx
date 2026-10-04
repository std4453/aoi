import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchPixivSettings } from '../api/pixiv';
import ImportSources from './ImportSources';
import PixivSettings from './PixivSettings';
import FanboxSettings from './FanboxSettings';
import { fetchFanboxSettings } from '../api/fanbox';
import Modal from './Modal';

export function PixivSettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  return createPortal(<Modal visible onClose={onClose} className="!max-w-lg">
    <div role="dialog" aria-modal="true" aria-label="Pixiv 配置">
      <PixivSettings onClose={onClose} onSaved={onSaved} />
    </div>
  </Modal>, document.body);
}

export function FanboxSettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  return createPortal(<Modal visible onClose={onClose} className="!max-w-lg">
    <div role="dialog" aria-modal="true" aria-label="FANBOX 配置">
      <FanboxSettings onClose={onClose} onSaved={onSaved} />
    </div>
  </Modal>, document.body);
}

export default function ExternalSourcesSettings() {
  const [selected, setSelected] = useState<'pixiv' | 'fanbox' | null>(null);
  const [configured, setConfigured] = useState<string[]>([]);
  const refresh = () => {
    void Promise.allSettled([fetchPixivSettings(), fetchFanboxSettings()]).then(results => {
      setConfigured(results.flatMap((result, index) => result.status === 'fulfilled' && result.value.configured ? [index === 0 ? 'pixiv' : 'fanbox'] : []));
    });
  };
  useEffect(refresh, []);
  return <>
    <ImportSources card title="外部来源" availableSources={['pixiv', 'fanbox']} configuredSources={configured} onSelect={source => { if (source !== 'mega') setSelected(source); }} />
    {selected === 'pixiv' && <PixivSettingsDialog onClose={() => { setSelected(null); refresh(); }} />}
    {selected === 'fanbox' && <FanboxSettingsDialog onClose={() => { setSelected(null); refresh(); }} />}
  </>;
}
