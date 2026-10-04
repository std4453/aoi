// Opt-in real-image lifecycle test. Never accesses AoI data, official servers,
// credentials or screenshots. Each test owns exactly one labeled container.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const dir = path.dirname(fileURLToPath(import.meta.url));
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'aoi-browser-smoke-'));
const key = randomBytes(32).toString('hex');
const docker = process.env.DOCKER_BIN || 'docker';
const run = args => exec(docker, args, { timeout: 60000, maxBuffer: 16384 });
let id;
try {
  await fs.writeFile(path.join(runtime, 'key'), key, { mode: 0o600 });
  // Explicit rejecting proxy: Chromium cannot send any official-site requests.
  await fs.writeFile(path.join(runtime, 'proxy.json'), JSON.stringify({ pixiv: 'http://127.0.0.1:1', fanbox: 'http://127.0.0.1:1' }), { mode: 0o600 });
  id = (await run(['run', '-d', '--label', 'io.aoi.purpose=browser-smoke', '--log-driver', 'none',
    '--security-opt', `seccomp=${path.join(dir, 'seccomp.json')}`, '--cpus', '2', '--memory', '3g', '--shm-size', '1g',
    '--tmpfs', '/config:rw,size=768m,mode=1777', '--tmpfs', '/run/aoi:rw,size=16m,mode=700',
    '--publish', '127.0.0.1::43129', '--publish', '127.0.0.1::43130',
    '--mount', `type=bind,source=${path.join(runtime, 'key')},target=/run/secrets/browser-key,readonly`,
    '--mount', `type=bind,source=${path.join(runtime, 'proxy.json')},target=/run/secrets/proxy.json,readonly`,
    '--env', 'AOI_BROWSER_PROXY_FILE=/run/secrets/proxy.json', '--env', 'AOI_BROWSER_TIMEOUT_SECONDS=30',
    '--env', 'AOI_BROWSER_PUBLIC_ORIGIN=https://browser.example.test',
    process.env.AOI_BROWSER_IMAGE || 'aoi-browser-login:local'])).stdout.trim();
  const mapped = async port => `http://${(await run(['port', id, `${port}/tcp`])).stdout.trim()}`;
  const control = await mapped(43129), viewer = await mapped(43130);
  const wait = async predicate => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { try { if (await predicate()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 250)); }
    throw new Error('Readiness timeout');
  };
  await wait(async () => (await fetch(`${control}/health`)).ok);
  const request = async (route, method = 'GET', body) => fetch(control + route, { method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const begin = async mobile => {
    const response = await request('/sessions', 'POST', { provider: 'fanbox', mobile, url: 'https://www.fanbox.cc/login', cookies: [] });
    assert.equal(response.status, 200); return response.json();
  };
  const clean = async () => {
    await run(['exec', id, 'sh', '-c', 'test ! -d /config/aoi-session && test ! -d /run/aoi/session && ! pgrep -x chromium >/dev/null && test -z "$(find /tmp -maxdepth 1 -name \*chromium\* -print -quit)"']);
  };
  assert.equal((await fetch(control + '/sessions', { method: 'POST' })).status, 401);
  const viewerRequest = (route, init = {}) => new Promise((resolve, reject) => {
    const req = http.request(viewer + route, { method: init.method || 'GET', headers: { Host: 'browser.example.test', Origin: 'https://browser.example.test', ...init.headers } }, response => {
      const chunks = []; response.on('data', c => chunks.push(c));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    req.on('error', reject); req.end(init.body);
  });
  assert.equal((await viewerRequest('/sessions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'X-Forwarded-Proto': 'http' } })).status, 404);
  assert.equal((await viewerRequest('/')).status, 401);
  let session = await begin(false);
  assert.equal((await request(`/sessions/${session.id}/capture`, 'POST')).status, 409);
  const attached = await viewerRequest('/attach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: session.launchToken }) });
  assert.equal(attached.status, 200);
  const cookie = attached.headers.get('set-cookie');
  assert.match(cookie, /; Secure/); assert.match(cookie, /HttpOnly/);
  assert.equal((await viewerRequest('/', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
  assert.equal((await request(`/sessions/${session.id}`, 'DELETE')).status, 200);
  await wait(async () => { await clean(); return true; });
  assert.equal((await viewerRequest('/', { headers: { Cookie: cookie.split(';')[0] } })).status, 401);
  console.log('PASS access boundaries, TLS-offload cookie, anonymous capture, cancellation cleanup');
  session = await begin(true);
  // Only synthetic local browser metadata is read; no DOM, account or images.
  const metrics = JSON.parse((await run(['exec', id, 'python3', '-c', `import sys,json,urllib.request;sys.path.insert(0,'/opt/aoi');from capture import CDP;p=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list'))[0];c=CDP(p['webSocketDebuggerUrl']);print(json.dumps(c.call('Runtime.evaluate',{'expression':'({width:screen.width,height:screen.height})','returnByValue':True})['result']['value']))`])).stdout);
  assert.equal(metrics.width, 390);
  await wait(async () => !(await (await request('/health')).json()).active);
  await wait(async () => { await clean(); return true; });
  assert.equal((await request(`/sessions/${session.id}/capture`, 'POST')).status, 410);
  console.log('PASS mobile viewport and timeout cleanup in the same container');
  await begin(false);
  await run(['exec', id, 's6-svc', '-k', '/run/service/svc-aoi-browser']);
  await wait(async () => { const r = await request('/health'); return r.ok && !(await r.json()).active; });
  await wait(async () => { await clean(); return true; });
  session = await begin(false);
  assert.equal((await request(`/sessions/${session.id}`, 'DELETE')).status, 200);
  await wait(async () => { await clean(); return true; });
  assert.equal((await run(['inspect', '--format', '{{.RestartCount}}', id])).stdout.trim(), '0');
  const listeners = (await run(['exec', id, 'ss', '-lntH'])).stdout;
  assert.ok(!/0\.0\.0\.0:(?:3000|3001|8082|9222|9223)\b/.test(listeners));
  console.log('PASS broker crash cleanup, next-session recovery, stable container, loopback internals');
} finally {
  if (id) await run(['rm', '-f', id]);
  await fs.rm(runtime, { recursive: true, force: true });
}
