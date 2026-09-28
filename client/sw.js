/* App shell and bounded, per-server request caches. No offline writes. */
const SHELL = 'aoi-shell-__VERSION__';
const PRECACHE = __PRECACHE__;
const DATA_PREFIX = 'aoi-data-';
const LIMIT = 200 * 1024 * 1024;
let writes = Promise.resolve();
let inventory = null;
async function cacheInventory() {
  if (inventory) return inventory;
  const entries = new Map();
  for (const name of (await caches.keys()).filter(name => name.startsWith(DATA_PREFIX))) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      entries.set(`${name} ${request.url}`, {
        name, key: request.url,
        size: Number(response?.headers.get('X-AoI-Size') || 0),
        time: Number(response?.headers.get('X-AoI-Time') || 0),
      });
    }
  }
  inventory = entries;
  return entries;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PRECACHE);
    if (!self.registration.active) await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Keep the previous shell for tabs still running the preceding version.
    const names = (await caches.keys()).filter(name => name.startsWith('aoi-shell-'));
    for (const name of names.slice(0, -2)) if (name !== SHELL) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'activate') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'clear-cache' && typeof event.data.record === 'string') {
    writes = writes.catch(() => {}).then(async () => {
      await caches.delete(DATA_PREFIX + event.data.record);
      inventory = null;
    });
    event.waitUntil(writes.then(() => event.ports[0]?.postMessage({ ok: true }), () => event.ports[0]?.postMessage({ ok: false })));
  }
});
async function notify(event, type, record) {
  const client = await self.clients.get(event.clientId);
  client?.postMessage({ type, record });
}
function cacheable(url) {
  return /^\/api\/(packs(?:\/[^/]+(?:\/(?:cover|thumbnails(?:\/.*)?|file-tree))?)?|tags(?:\/[^/]+\/packs)?|presets(?:\/[^/]+)?)$/.test(url.pathname);
}
async function trimCache(required = 0, replacing = null) {
  const inventory = await cacheInventory();
  const entries = [...inventory.entries()].filter(([id]) => id !== replacing).sort((a, b) => a[1].time - b[1].time);
  let total = entries.reduce((sum, [, entry]) => sum + entry.size, 0);
  while (entries.length && total + required > LIMIT) {
    const [id, entry] = entries.shift();
    await (await caches.open(entry.name)).delete(entry.key);
    inventory.delete(id);
    total -= entry.size;
  }
}
async function storeResponse(name, key, response) {
  const data = await response.arrayBuffer();
  if (data.byteLength > LIMIT / 4) return;
  const headers = new Headers(response.headers);
  headers.set('X-AoI-Size', String(data.byteLength));
  headers.set('X-AoI-Time', String(Date.now()));
  const inventory = await cacheInventory();
  const id = `${name} ${key}`;
  await trimCache(data.byteLength, id);
  const cache = await caches.open(name);
  try {
    await cache.put(key, new Response(data, { status: response.status, headers }));
    inventory.set(id, { name, key, size: data.byteLength, time: Date.now() });
  } catch (error) {
    // Storage is best effort. A full browser quota must never break online reads.
    if (error.name === 'QuotaExceededError') await trimCache(LIMIT / 2);
  }
}
async function business(event, url) {
  const record = url.searchParams.get('__aoi_record');
  const name = DATA_PREFIX + record;
  const keyUrl = new URL(url);
  for (const parameter of ['access_token', '__aoi_record', '__aoi_offline']) keyUrl.searchParams.delete(parameter);
  const key = keyUrl.href;
  const eligible = cacheable(url);
  if (!url.searchParams.has('__aoi_offline')) {
    try {
      const response = await fetch(event.request);
      if (response.status === 401) await notify(event, 'unauthorized', record);
      if (response.status < 502 || response.status > 504) {
        if (eligible && response.ok && response.type !== 'opaque') {
          const copy = response.clone();
          writes = writes.catch(() => {}).then(() => storeResponse(name, key, copy));
          event.waitUntil(writes.catch(() => {}));
        }
        return response;
      }
    } catch { /* Fall through to cached data only on transport/server availability failures. */ }
    await notify(event, 'offline', record);
  }
  if (eligible) {
    const cache = await caches.open(name);
    const response = await cache.match(key);
    if (response) {
      const touched = response.clone();
      writes = writes.catch(() => {}).then(async () => {
        const headers = new Headers(touched.headers);
        headers.set('X-AoI-Time', String(Date.now()));
        await cache.put(key, new Response(touched.body, { status: 200, headers }));
        const entry = (await cacheInventory()).get(`${name} ${key}`);
        if (entry) entry.time = Date.now();
      });
      event.waitUntil(writes.catch(() => {}));
      const headers = new Headers(response.headers);
      headers.set('X-AoI-Cache', 'offline');
      return new Response(response.body, { status: 200, headers });
    }
  }
  return new Response(JSON.stringify({ error: '服务器不可达，且此内容没有离线缓存' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-AoI-Cache': 'offline' } });
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.searchParams.has('__aoi_record') && url.pathname.startsWith('/api/')) {
    event.respondWith(business(event, url));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/runtime-config.json') {
    event.respondWith((async () => {
      const cache = await caches.open('aoi-runtime');
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put(url.pathname, response.clone());
        return response;
      } catch {
        return (await cache.match(url.pathname)) || Response.error();
      }
    })());
  } else if (!url.pathname.startsWith('/api/') && (event.request.mode === 'navigate' || PRECACHE.includes(url.pathname) || url.pathname.startsWith('/assets/'))) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const path = event.request.mode === 'navigate' ? '/index.html' : url.pathname;
      const current = await cache.match(path);
      if (current) return current;
      // Tabs using the preceding JS bundle may still request one of its lazy chunks.
      if (path.startsWith('/assets/')) {
        for (const name of (await caches.keys()).filter(name => name.startsWith('aoi-shell-'))) {
          const previous = await (await caches.open(name)).match(path);
          if (previous) return previous;
        }
      }
      return fetch(event.request);
    })());
  }
});
