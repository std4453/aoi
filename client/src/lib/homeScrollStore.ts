let homeScrollY = 0;
let lastHomeSearch = '';

export function getHomeScrollY() { return homeScrollY; }
export function saveHomeScrollY() { homeScrollY = window.scrollY; }
export function clearHomeScrollY() { homeScrollY = 0; }

export function getLastHomeSearch() { return lastHomeSearch; }
export function saveLastHomeSearch(search: string) { lastHomeSearch = search; }
export function clearLastHomeSearch() { lastHomeSearch = ''; }
