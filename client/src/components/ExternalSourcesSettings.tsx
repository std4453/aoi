import { useEffect, useState } from 'react';
import { fetchPixivSettings } from '../api/pixiv';
import ImportSources from './ImportSources';
import PixivSettingsDialog from './PixivSettingsDialog';
import FanboxSettingsDialog from './FanboxSettingsDialog';
import { fetchFanboxSettings } from '../api/fanbox';

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
