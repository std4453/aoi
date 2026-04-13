import type { Pack } from '../../../shared/types';

// --- Pack data cache ---
let _packCache: { packs: Pack[]; total: number; page: number; search: string } | null = null;

export function getPacksCache(page: number, search: string): { packs: Pack[]; total: number } | null {
  if (_packCache !== null && _packCache.page === page && _packCache.search === search) {
    return { packs: _packCache.packs, total: _packCache.total };
  }
  return null;
}

export function setPacksCache(packs: Pack[], total: number, page: number, search: string) {
  _packCache = { packs, total, page, search };
}

export function clearPacksCache() { _packCache = null; }

// --- Scroll position ---
let _scrollY = 0;

export function getHomeScrollY() { return _scrollY; }
export function saveHomeScrollY() { _scrollY = window.scrollY; }
export function clearHomeScrollY() { _scrollY = 0; }

// --- Last search ---
let _lastSearch = '';

export function getLastHomeSearch() { return _lastSearch; }
export function saveLastHomeSearch(search: string) { _lastSearch = search; }
export function clearLastHomeSearch() { _lastSearch = ''; }

// --- Reset callback (replaces home:hard-reset DOM event) ---
let _onReset: (() => void) | null = null;

export function onHomeReset(callback: () => void) {
  _onReset = callback;
  return () => { _onReset = null; };
}

export function triggerHomeReset() {
  clearPacksCache();
  clearHomeScrollY();
  clearLastHomeSearch();
  _onReset?.();
}
