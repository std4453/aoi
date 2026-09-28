import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the worker's network/cache boundary with real Request/Response objects.
// Browser smoke checks additionally verify the actual Cache API and SW lifecycle.
function worker(limit?: number) {
  const stores = new Map<string, Map<string, Response>>();
  const handlers = new Map<string, (event: any) => void>();
  const messages: unknown[] = [];
  let network: () => Promise<Response> = async () => Response.json({ name: 'cached pack' });
  const source = fs.readFileSync(new URL('../../client/sw.js', import.meta.url), 'utf8')
    .replace('__VERSION__', 'test').replace('__PRECACHE__', '[]')
    .replace('200 * 1024 * 1024', String(limit ?? 200 * 1024 * 1024));
  vm.runInNewContext(source, {
    URL, Request, Response, Headers, console,
    fetch: () => network(),
    caches: {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name)!;
        const key = (value: string | Request) => typeof value === 'string' ? value : value.url;
        return {
          keys: async () => [...store.keys()].map(value => new Request(value)),
          match: async (value: string | Request) => store.get(key(value))?.clone(),
          put: async (value: string | Request, response: Response) => { store.set(key(value), response.clone()); },
          delete: async (value: string | Request) => store.delete(key(value)),
        };
      },
    },
    self: {
      location: { origin: 'https://frontend.example' },
      addEventListener: (name: string, callback: (event: any) => void) => handlers.set(name, callback),
      clients: { get: async () => ({ postMessage: (value: unknown) => messages.push(value) }) },
    },
  });
  return {
    stores, messages,
    network: (fn: typeof network) => { network = fn; },
    async request(path: string, record = 'first', offline = false, method = 'GET', pwa = true) {
      let response: Promise<Response> | undefined;
      const pending: Promise<unknown>[] = [];
      const url = new URL(path, 'https://backend.example');
      url.searchParams.set('__aoi_record', record);
      if (pwa) url.searchParams.set('__aoi_pwa', '1');
      url.searchParams.set('access_token', 'temporary-secret');
      if (offline) url.searchParams.set('__aoi_offline', '1');
      handlers.get('fetch')!({
        request: new Request(url, { method }), clientId: 'browser',
        respondWith: (value: Promise<Response>) => { response = value; },
        waitUntil: (value: Promise<unknown>) => pending.push(value),
      });
      const result = await response;
      await Promise.all(pending);
      return result;
    },
  };
}

test('offline cache isolates records, strips credentials, and never masks authentication failures', async () => {
  const sw = worker();
  assert.equal((await sw.request('/api/packs?page=1'))?.status, 200);
  const keys = [...sw.stores.get('aoi-data-first')!.keys()];
  assert.deepEqual(keys, ['https://backend.example/api/packs?page=1']);
  sw.network(async () => { throw new TypeError('Network unavailable'); });
  const cached = await sw.request('/api/packs?page=1');
  assert.equal(cached?.headers.get('X-AoI-Cache'), 'offline');
  assert.deepEqual(await cached?.json(), { name: 'cached pack' });
  assert.equal((await sw.request('/api/packs?page=1', 'second'))?.status, 503);
  assert.equal((await sw.request('/api/packs?page=2'))?.status, 503);
  sw.network(async () => new Response('Key invalid', { status: 401 }));
  assert.equal((await sw.request('/api/packs?page=1'))?.status, 401);
  assert.ok(sw.messages.some((item: any) => item.type === 'unauthorized'));
  sw.network(async () => { throw new Error('Offline mode must not request the network'); });
  assert.equal((await sw.request('/api/packs?page=1', 'first', true))?.status, 200);
});

test('only successful allowed reads are cached, excluding originals, downloads, jobs and writes', async () => {
  const sw = worker();
  for (const path of ['/api/packs/id/images/a.png', '/api/packs/id/download', '/api/jobs/id', '/api/jobs/id/events', '/api/health', '/api/auth/login']) {
    await sw.request(path);
  }
  assert.equal(sw.stores.size, 0);
  assert.equal(await sw.request('/api/packs', 'first', false, 'POST'), undefined);
  sw.network(async () => new Response('Missing', { status: 404 }));
  await sw.request('/api/packs/id/thumbnails/a.jpg');
  assert.equal(sw.stores.size, 0);
  sw.network(async () => new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }));
  await sw.request('/api/packs/id/thumbnails/a.jpg');
  assert.equal(sw.stores.get('aoi-data-first')?.size, 1);
});


test('replacing the oldest cached response cannot exceed the shared byte limit', async () => {
  const sw = worker(200);
  sw.network(async () => new Response('x'.repeat(40)));
  for (let index = 0; index < 5; index++) await sw.request(`/api/packs/id-${index}`);
  sw.network(async () => new Response('y'.repeat(50)));
  await sw.request('/api/packs/id-0');
  let bytes = 0;
  for (const store of sw.stores.values()) {
    for (const response of store.values()) bytes += (await response.clone().arrayBuffer()).byteLength;
  }
  assert.ok(bytes <= 200, `Cached ${bytes} bytes with a 200 byte budget`);
});


test('ordinary browser requests bypass an existing PWA worker without reading or writing data caches', async () => {
  const sw = worker();
  assert.equal(await sw.request('/api/packs', 'first', false, 'GET', false), undefined);
  assert.equal(sw.stores.size, 0);
  await sw.request('/api/packs');
  const before = [...sw.stores.get('aoi-data-first')!.keys()];
  assert.equal(await sw.request('/api/packs?page=2', 'first', false, 'GET', false), undefined);
  sw.network(async () => { throw new TypeError('Network unavailable'); });
  assert.equal(await sw.request('/api/packs', 'first', true, 'GET', false), undefined);
  assert.deepEqual([...sw.stores.get('aoi-data-first')!.keys()], before);
  assert.equal((await sw.request('/api/packs', 'first', true))?.status, 200);
});
