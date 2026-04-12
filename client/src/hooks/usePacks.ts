import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchPacks, removePack } from '../api/packs';
import type { Pack, PackListParams } from '../../../shared/types.js';

const DEFAULT_PAGE_SIZE = 20;

export function usePacks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Read page/search from URL
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const search = searchParams.get('search') || '';

  const refresh = useCallback(async (params: PackListParams) => {
    // Cancel in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const data = await fetchPacks(params, controller.signal);
      if (controller.signal.aborted) return;
      setPacks(data.items);
      setTotal(data.total);

      // Edge case: current page is empty but total > 0 → jump to last page
      if (data.total > 0 && data.items.length === 0 && data.page > 1) {
        const lastPage = Math.ceil(data.total / DEFAULT_PAGE_SIZE);
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.set('page', String(lastPage));
          return next;
        }, { replace: true });
        return;
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [setSearchParams]);

  // Fetch on page or search change
  useEffect(() => {
    const params: PackListParams = { page, pageSize: DEFAULT_PAGE_SIZE };
    if (search) params.search = search;
    refresh(params);
    return () => { abortRef.current?.abort(); };
  }, [page, search, refreshKey, refresh]);

  const deletePack = useCallback(
    async (id: string) => {
      await removePack(id);
      const params: PackListParams = { page, pageSize: DEFAULT_PAGE_SIZE };
      if (search) params.search = search;
      refresh(params);
    },
    [page, search, refresh]
  );

  const goToPage = useCallback((p: number) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('page', String(p));
      return next;
    }); // push (default)
  }, [setSearchParams]);

  const hardReset = useCallback(() => {
    setPacks([]);
    setTotal(0);
    setError(null);
    setLoading(true);
    setSearchParams({}, { replace: true });
    setRefreshKey(k => k + 1);
  }, [setSearchParams]);

  const setSearchQuery = useCallback((q: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (q) {
        next.set('search', q);
      } else {
        next.delete('search');
      }
      next.set('page', '1'); // reset to page 1 on search change
      return next;
    }); // push (default)
  }, [setSearchParams]);

  return {
    packs,
    total,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    search,
    loading,
    error,
    refresh: useCallback(() => {
      const params: PackListParams = { page, pageSize: DEFAULT_PAGE_SIZE };
      if (search) params.search = search;
      refresh(params);
    }, [page, search, refresh]),
    hardReset,
    deletePack,
    goToPage,
    setSearchQuery,
  };
}
