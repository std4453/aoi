import { useState, useEffect, useCallback } from 'react';
import { fetchPacks, removePack } from '../api/packs';
import type { Pack } from '../../../shared/types.js';

export function usePacks() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPacks();
      setPacks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deletePack = useCallback(
    async (id: string) => {
      await removePack(id);
      setPacks((prev) => prev.filter((p) => p.id !== id));
    },
    []
  );

  return { packs, loading, error, refresh, deletePack };
}
