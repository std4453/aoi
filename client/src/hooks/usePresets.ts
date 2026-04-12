import { useState, useEffect, useCallback } from 'react';
import { fetchPresets, createPreset, updatePreset, removePreset, setDefaultPreset } from '../api/presets';
import type { Preset, CompressionOptions } from '../../../shared/types.js';

export function usePresets() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPresets();
      setPresets(data);
    } catch (err) {
      console.error('Failed to fetch presets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (name: string, options: CompressionOptions, isDefault?: boolean) => {
      const preset = await createPreset(name, options, isDefault);
      setPresets((prev) => [...prev, preset]);
      return preset;
    },
    []
  );

  const edit = useCallback(async (id: string, name: string, options: CompressionOptions) => {
    const updated = await updatePreset(id, name, options);
    setPresets((prev) => prev.map((p) => (p.id === id ? updated : p)));
    return updated;
  }, []);

  const remove = useCallback(async (id: string) => {
    await removePreset(id);
    setPresets((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const setDefault = useCallback(async (id: string) => {
    await setDefaultPreset(id);
    setPresets((prev) =>
      prev.map((p) => ({ ...p, isDefault: p.id === id }))
    );
  }, []);

  const defaultPreset = presets.find((p) => p.isDefault) ?? null;

  return { presets, defaultPreset, loading, refresh, add, edit, remove, setDefault };
}
