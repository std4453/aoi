import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
let caseId = 0;
const primary = { status: 'ok', service: 'aoi', authRequired: true, writable: true, role: 'standalone', capabilities: { snapshots: true, generatedArchiveDownload: true } };
const server = { id: 'primary', alias: 'Test primary', address: 'http://127.0.0.1:3101', key: 'test-key', token: 'cached-token' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t: TestContext) {
  const navigations: string[] = [];
  for (const [name, value] of Object.entries({
    localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage(),
    location: { origin: 'http://127.0.0.1:3100', assign: (url: string) => navigations.push(url) },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const connection = await import(`../../client/src/lib/connection.ts?case=${++caseId}`) as typeof import('../../client/src/lib/connection');
  t.after(() => connection.cancelConnection());
  connection.runtime.serverSelectionEnabled = true;
  return { connection, navigations };
}

test('cached credentials issue requests immediately while login refreshes the token', async t => {
  const { connection, navigations } = await setup(t);
  const health = deferred<Response>();
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/health')) return health.promise;
    if (url.endsWith('/api/auth/login')) return json({ token: 'renewed-token' });
    requests.push(new Headers(init.headers).get('Authorization')!);
    return json({ ok: true });
  });
  assert.equal(connection.restoreCachedConnection(server), true);
  const connecting = connection.connectServer(server);
  assert.equal((await connection.apiFetch('/api/example')).status, 200);
  assert.deepEqual(requests, ['Bearer cached-token']);
  health.resolve(json(primary));
  await connecting;
  await connection.apiFetch('/api/example');
  assert.deepEqual(requests, ['Bearer cached-token', 'Bearer renewed-token']);
  assert.equal(connection.savedServers()[0].token, 'renewed-token');
  assert.equal(connection.activeServer?.role, 'standalone');
  assert.deepEqual(navigations, []);
});

test('expired cached tokens retry reads after background login without redirecting', async t => {
  const { connection, navigations } = await setup(t);
  const health = deferred<Response>();
  const staleRequested = deferred<void>();
  const tokens: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/health')) return health.promise;
    if (url.endsWith('/api/auth/login')) return json({ token: 'new-token' });
    const auth = new Headers(init.headers).get('Authorization')!;
    tokens.push(auth);
    if (auth === 'Bearer cached-token') { staleRequested.resolve(); return json({}, 401); }
    return json({ ok: true });
  });
  connection.restoreCachedConnection(server);
  const connecting = connection.connectServer(server);
  const response = connection.apiFetch('/api/example');
  await staleRequested.promise;
  health.resolve(json(primary));
  await connecting;
  assert.equal((await response).status, 200);
  assert.deepEqual(tokens, ['Bearer cached-token', 'Bearer new-token']);
  assert.equal(connection.getConnectionState().status, 'connected');
  assert.deepEqual(navigations, []);
});

test('failed background connections keep the session and normal requests available', async t => {
  const { connection, navigations } = await setup(t);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/api/health')) throw new TypeError('Network unavailable');
    return json({ ok: true });
  });
  connection.restoreCachedConnection(server);
  await assert.rejects(connection.connectServer(server), /Network unavailable/);
  assert.equal(connection.getConnectionState().status, 'failed');
  assert.equal(connection.authHeaders().Authorization, 'Bearer cached-token');
  assert.equal((await connection.apiFetch('/api/example', { method: 'POST' })).status, 200);
  assert.deepEqual(navigations, []);
  connection.returnToServers();
  assert.deepEqual(navigations, ['/servers']);
});

test('failed authentication does not force a cached session out of the page', async t => {
  const { connection, navigations } = await setup(t);
  t.mock.method(globalThis, 'fetch', async (url: string) => url.endsWith('/api/health') ? json(primary) : json({}, 401));
  connection.restoreCachedConnection(server);
  await assert.rejects(connection.connectServer(server), connection.LoginError);
  assert.equal((await connection.apiFetch('/api/example')).status, 401);
  assert.equal(connection.getConnectionState().status, 'failed');
  assert.equal(connection.savedServers()[0].token, undefined);
  assert.deepEqual(navigations, []);
});

test('cancellation aborts health and ignores a late response', async t => {
  const { connection } = await setup(t);
  const health = deferred<Response>();
  let signal!: AbortSignal;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signal = init.signal!; calls++; return health.promise;
  });
  const connecting = connection.connectServer(server);
  connection.cancelConnection();
  assert.equal(signal.aborted, true);
  health.resolve(json(primary));
  await assert.rejects(connecting, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(connection.activeServer, null);
  assert.deepEqual(connection.savedServers(), []);
});

test('a cancelled login cannot overwrite a later server connection', async t => {
  const { connection } = await setup(t);
  const oldLogin = deferred<Response>();
  const loginStarted = deferred<void>();
  let oldSignal!: AbortSignal;
  const replica = { ...server, id: 'replica', address: 'http://127.0.0.1:3102', token: undefined };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/health')) return json(url.startsWith(replica.address)
      ? { ...primary, role: 'replica', writable: false, capabilities: { snapshots: false, generatedArchiveDownload: false } } : primary);
    if (url.startsWith(server.address)) { oldSignal = init.signal!; loginStarted.resolve(); return oldLogin.promise; }
    return json({ token: 'replica-token' });
  });
  const oldAttempt = connection.connectServer(server);
  await loginStarted.promise;
  await connection.connectServer(replica);
  assert.equal(oldSignal.aborted, true);
  oldLogin.resolve(json({ token: 'obsolete-token' }));
  await assert.rejects(oldAttempt, { name: 'AbortError' });
  assert.equal(connection.activeServer?.id, 'replica');
  assert.equal(connection.authHeaders().Authorization, 'Bearer replica-token');
  assert.deepEqual(connection.savedServers().map(item => item.id), ['replica']);
  assert.equal(connection.getConnectionState().serverWritable, false);
  assert.equal(connection.getConnectionState().serverCanDownloadArchive, false);
});

test('records without tokens and same-origin deployments retain the login gate', async t => {
  const { connection } = await setup(t);
  assert.equal(connection.restoreCachedConnection({ ...server, token: undefined }), false);
  connection.runtime.serverSelectionEnabled = false;
  assert.equal(connection.restoreCachedConnection(server), false);
  assert.equal(connection.activeServer, null);
});
