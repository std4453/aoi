import { useEffect, useState } from 'react';
import { fetchPixivSettings } from '../api/pixiv';
import ImportSources from './ImportSources';
import PixivSettingsDialog from './PixivSettingsDialog';
import FanboxSettingsDialog from './FanboxSettingsDialog';
import MegaSettingsDialog from './MegaSettingsDialog';
import { fetchMegaSettings } from '../api/mega';
import { fetchFanboxSettings } from '../api/fanbox';

export default function ExternalSourcesSettings() {
  const [selected, setSelected] = useState<'pixiv' | 'fanbox' | 'mega' | null>(null);
  const [configured, setConfigured] = useState<string[]>([]);
  const refresh = () => {
    void Promise.allSettled([fetchPixivSettings(), fetchFanboxSettings(), fetchMegaSettings()]).then(results => {
      setConfigured(results.flatMap((result, index) => result.status === 'fulfilled' && result.value.configured && !('expired' in result.value && result.value.expired) ? [['pixiv', 'fanbox', 'mega'][index]] : []));
    });
  };
  useEffect(refresh, []);
  return <>
    <ImportSources card title="外部来源" availableSources={['pixiv', 'fanbox', 'mega']} configuredSources={configured} onSelect={setSelected} />
    {selected === 'pixiv' && <PixivSettingsDialog onClose={() => { setSelected(null); refresh(); }} />}
    {selected === 'mega' && <MegaSettingsDialog onClose={() => { setSelected(null); refresh(); }} />}
    {selected === 'fanbox' && <FanboxSettingsDialog onClose={() => { setSelected(null); refresh(); }} />}
  </>;
}
