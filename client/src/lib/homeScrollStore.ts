let homeScrollY = 0;

export function getHomeScrollY() { return homeScrollY; }
export function saveHomeScrollY() { homeScrollY = window.scrollY; }
export function clearHomeScrollY() { homeScrollY = 0; }
