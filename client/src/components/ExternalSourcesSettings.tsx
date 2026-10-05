import { useEffect, useState } from 'react';
import type { RemoteTaskType } from '../../../shared/types';
import { fetchPixivSettings } from '../api/pixiv';
import { fetchMegaSettings } from '../api/mega';
import { fetchFanboxSettings } from '../api/fanbox';
import ImportSources from './ImportSources';
import PixivSettingsDialog from './PixivSettingsDialog';
import FanboxSettingsDialog from './FanboxSettingsDialog';
import MegaSettingsDialog from './MegaSettingsDialog';

const settingsLoaders = {
  pixiv: fetchPixivSettings,
  fanbox: fetchFanboxSettings,
  mega: fetchMegaSettings,
} satisfies Record<RemoteTaskType, () => Promise<{ configured: boolean; expired?: boolean }>>;
const sources = Object.keys(settingsLoaders) as RemoteTaskType[];

export default function ExternalSourcesSettings() {
  const [selected, setSelected] = useState<RemoteTaskType | null>(null);
  const [configured, setConfigured] = useState<RemoteTaskType[]>([]);
  const refresh = () => {
    void Promise.allSettled(sources.map(source => settingsLoaders[source]())).then(results => {
      setConfigured(results.flatMap((result, index) => result.status === 'fulfilled' && result.value.configured && !('expired' in result.value && result.value.expired) ? [sources[index]] : []));
    });
  };
  useEffect(refresh, []);
  return <>
    <ImportSources card title="外部来源" availableSources={sources} configuredSources={configured} onSelect={setSelected} />
    {selected === 'pixiv' && <PixivSettingsDialog onClose={() => { setSelected(null); refresh(); }} />}
    {selected === 'mega' && <MegaSettingsDialog onClose={() => { setSelected(null); refresh(); }} />}
    {selected === 'fanbox' && <FanboxSettingsDialog onClose={() => { setSelected(null); refresh(); }} />}
  </>;
}
