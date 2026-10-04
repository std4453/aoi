import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-browser-login-test-'));
process.env.DATA_DIR = data;
process.env.AOI_BROWSER_LOGIN_URL = 'http://127.0.0.1:43999';
process.env.AOI_BROWSER_LOGIN_PUBLIC_URL = 'https://browser.example.test';
process.env.AOI_BROWSER_LOGIN_KEY_FILE = path.join(data, 'broker.key');
delete process.env.FANBOX_COOKIES_FILE;
delete process.env.FANBOX_SESSION_ID;
delete process.env.AUTH_KEY;
fs.writeFileSync(process.env.AOI_BROWSER_LOGIN_KEY_FILE, 'b'.repeat(64), { mode: 0o600 });
const { BrowserLogin, browserLogin } = await import('../src/services/browser-login.js');
const { readFanboxSettings } = await import('../src/services/fanbox-auth.js');
const { config } = await import('../src/config.js');
const { registerBrowserLoginRoutes } = await import('../src/routes/browser-login.js');
const { default: Fastify } = await import('fastify');
const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);
const pool = agent.get('http://127.0.0.1:43999');
const id = '0e1df6ed-5c38-486b-80c7-d8d59fcedd79';
const remoteSession = () => ({ id, expiresAt: new Date(Date.now() + 300000).toISOString(), launchToken: 'c'.repeat(64) });

test('browser login saves only FANBOX credential and closes the isolated session', async () => {
  const service = new BrowserLogin();
  pool.intercept({ path: '/sessions', method: 'POST', headers: { authorization: `Bearer ${'b'.repeat(64)}` } }).reply(200, remoteSession());
  const session = await service.start();
  assert.equal(new URL(session.browserUrl).origin, 'https://browser.example.test');
  assert.equal(new URL(session.browserUrl).search, '');
  assert.equal(new URL(session.browserUrl).hash, `#${'c'.repeat(64)}`);
  assert.deepEqual(await service.start(), session);
  pool.intercept({ path: `/sessions/${id}/capture`, method: 'POST' }).reply(200, { sessionId: 'test-session' });
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(200, { closed: true });
  assert.equal(await service.complete(id), undefined);
  assert.equal(service.status()?.completed, true);
  assert.equal(readFanboxSettings().sessionId, 'test-session');
  assert.equal(fs.statSync(path.join(data, 'fanbox-settings.json')).mode & 0o777, 0o600);
});

test('not logged in, concurrent operations, stale sessions, and file-managed credentials fail closed', async () => {
  const service = new BrowserLogin();
  pool.intercept({ path: '/sessions', method: 'POST' }).reply(200, remoteSession()).delay(40);
  const pending = service.start();
  await assert.rejects(service.start(), /正在处理/);
  await pending;
  pool.intercept({ path: `/sessions/${id}/capture`, method: 'POST' }).reply(409, { error: 'not_logged_in' });
  await assert.rejects(service.complete(id));
  assert.equal(readFanboxSettings().sessionId, 'test-session');
  await assert.rejects(service.complete('different-session'));
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(200, { closed: true });
  await service.cancel(id);
  config.fanbox.cookiesFile = '/not-used';
  await assert.rejects(service.start(), /Cookie 文件/);
  config.fanbox.cookiesFile = undefined;
});

test('cleanup failure preserves a retryable handle and never leaks a captured credential in errors', async () => {
  const service = new BrowserLogin();
  pool.intercept({ path: '/sessions', method: 'POST' }).reply(200, remoteSession());
  await service.start();
  pool.intercept({ path: `/sessions/${id}/capture`, method: 'POST' }).reply(200, { sessionId: 'test-rotated' });
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(503, { secret: 'test-rotated' });
  await assert.rejects(service.complete(id), error => error instanceof Error && !error.message.includes('test-rotated'));
  assert.ok(service.status());
  assert.equal(readFanboxSettings().sessionId, 'test-rotated');
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(200, { closed: true });
  await service.cancel(id);
});

test('completion retries a lost cleanup response without capturing credentials again', async () => {
  const service = new BrowserLogin();
  pool.intercept({ path: '/sessions', method: 'POST' }).reply(200, remoteSession());
  await service.start();
  pool.intercept({ path: `/sessions/${id}/capture`, method: 'POST' }).reply(200, { sessionId: 'synthetic-retry-session' });
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).replyWithError(new Error('connection reset'));
  try {
    await assert.rejects(service.complete(id), /无法连接/);
    assert.equal(readFanboxSettings().sessionId, 'synthetic-retry-session');
    assert.equal(service.status()?.completed, undefined);
    pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(410, { error: 'session_gone' });
    await service.complete(id);
    assert.equal(service.status()?.completed, true);
    assert.equal(service.status()?.browserUrl, '');
    assert.equal(service.error('fanbox'), undefined);
  } finally { await service.close(); }
});

test('loopback login routes reject cross-site and malformed control requests', async () => {
  const app = Fastify();
  await app.register(registerBrowserLoginRoutes);
  const base = '/api/settings/fanbox/browser-login';
  assert.equal((await app.inject({ method: 'POST', url: base, headers: { host: '127.0.0.1' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: base, headers: { host: 'evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: base, headers: { host: '127.0.0.1', origin: 'https://evil.example' } })).statusCode, 403);
  pool.intercept({ path: '/sessions', method: 'POST' }).reply(200, remoteSession());
  const started = await app.inject({ method: 'POST', url: base, headers: { host: '127.0.0.1', 'x-aoi-browser-login': '1' } });
  assert.equal(started.statusCode, 200);
  pool.intercept({ path: `/sessions/${id}/capture`, method: 'POST' }).reply(200, { sessionId: 'test-private-cookie' });
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(200, { closed: true });
  const completed = await app.inject({ method: 'POST', url: `${base}/${id}/complete`, headers: { host: '127.0.0.1', 'x-aoi-browser-login': '1' } });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().configured, true);
  assert.equal(completed.headers['cache-control'], 'no-store');
  assert.ok(!completed.body.includes('test-private-cookie'));
  assert.equal(browserLogin.status()?.completed, true);
  await app.close();
});

test('Vite preserves same-origin login requests without trusting forwarded headers', async () => {
  const { default: vite } = await import('../../client/vite.config.ts');
  const proxy = vite.server?.proxy?.['/api'];
  assert.equal(typeof proxy === 'object' && proxy.changeOrigin, false);
  const app = Fastify();
  await app.register(registerBrowserLoginRoutes);
  const base = '/api/settings/fanbox/browser-login';
  const headers = { host: 'localhost:5173', origin: 'http://localhost:5173', 'x-aoi-browser-login': '1' };
  try {
    pool.intercept({ path: '/sessions', method: 'POST' }).reply(200, remoteSession());
    const started = await app.inject({ method: 'POST', url: base, headers });
    assert.equal(started.statusCode, 200, started.body);
    assert.equal((await app.inject({ method: 'POST', url: base,
      headers: { ...headers, origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: base,
      headers: { ...headers, host: 'evil.example', origin: 'http://evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: base,
      headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
    pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(200, { closed: true });
    assert.equal((await app.inject({ method: 'DELETE', url: `${base}/${id}`, headers })).statusCode, 200);
  } finally { await app.close(); }
});

test.after(async () => {
  agent.assertNoPendingInterceptors();
  await agent.close();
  fs.rmSync(data, { recursive: true, force: true });
});

test('Pixiv browser login exchanges its PKCE code unchanged, preserves only web session cookies, and permits FANBOX SSO', async () => {
  const service = new BrowserLogin();
  let verifier = '';
  pool.intercept({ path: '/sessions', method: 'POST' }).reply(200, remoteSession());
  const session = await service.start('pixiv', true);
  assert.equal(session.provider, 'pixiv');
  const cookies = [{ name: 'PHPSESSID', value: 'synthetic-web-session', domain: '.pixiv.net', path: '/', secure: true, httpOnly: true }];
  pool.intercept({ path: `/sessions/${id}/capture`, method: 'POST' }).reply(200, { code: 'synthetic-code', cookies });
  agent.get('https://oauth.secure.pixiv.net').intercept({ path: '/auth/token', method: 'POST', body: body => {
    const params = new URLSearchParams(String(body)); verifier = params.get('code_verifier') || '';
    return params.get('grant_type') === 'authorization_code' && params.get('code') === 'synthetic-code' && /^[\w-]{43}$/.test(verifier);
  } }).reply(200, { refresh_token: 'synthetic-original-refresh-token' });
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(200, { closed: true });
  await service.complete(id, 'pixiv');
  assert.equal(service.status('pixiv')?.completed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'pixiv-settings.json'), 'utf8')).refreshToken, 'synthetic-original-refresh-token');
  assert.equal(fs.statSync(path.join(data, 'pixiv-browser-cookies.json')).mode & 0o777, 0o600);
  pool.intercept({ path: '/sessions', method: 'POST', body: body => {
    const input = JSON.parse(String(body));
    return input.provider === 'fanbox' && input.cookies[0]?.value === 'synthetic-web-session' && !input.url.includes(verifier);
  } }).reply(200, remoteSession());
  await service.start('fanbox');
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(200, { closed: true });
  await service.cancel(id, 'fanbox');
  const { clearPixivWebSession } = await import('../src/services/browser-login.js');
  clearPixivWebSession();
  assert.equal(fs.existsSync(path.join(data, 'pixiv-browser-cookies.json')), false);
});

test('FANBOX automatically waits for authentication, saves and closes without a manual complete request', async () => {
  const service = new BrowserLogin();
  pool.intercept({ path: '/sessions', method: 'POST' }).reply(200, remoteSession());
  pool.intercept({ path: `/sessions/${id}/capture`, method: 'POST' }).reply(409, { error: 'not_logged_in' });
  pool.intercept({ path: `/sessions/${id}/capture`, method: 'POST' }).reply(200, { sessionId: 'automatic-fanbox-session' });
  pool.intercept({ path: `/sessions/${id}`, method: 'DELETE' }).reply(200, { closed: true });
  try {
    await service.start('fanbox');
    const deadline = Date.now() + 7000;
    while (!service.status('fanbox')?.completed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(service.status('fanbox')?.completed, true);
    assert.equal(readFanboxSettings().sessionId, 'automatic-fanbox-session');
    assert.equal(service.error('fanbox'), undefined);
    assert.equal(service.status('fanbox')?.browserUrl, '');
  } finally { await service.close(); }
});
