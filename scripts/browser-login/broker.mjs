import http from 'node:http';
import https from 'node:https';
import { connectViaProxy } from './proxy-tunnel.mjs';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(process.env.AOI_BROWSER_RUNTIME || '/tmp/aoi-browser-login-dev');
const port = Number(process.env.AOI_BROWSER_PORT || 43129);
const localOrigin = `http://127.0.0.1:${port}`;
const publicOrigin = process.env.AOI_BROWSER_PUBLIC_ORIGIN || localOrigin;
const publicUrl = new URL(publicOrigin);
const tlsCertFile = process.env.AOI_BROWSER_TLS_CERT_FILE;
const tlsKeyFile = process.env.AOI_BROWSER_TLS_KEY_FILE;
if (publicOrigin !== localOrigin && (publicUrl.protocol !== 'https:' || !tlsCertFile || !tlsKeyFile || !publicUrl.port || publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash)) throw new Error('LAN viewer requires an explicit HTTPS origin and certificate');
const docker = process.env.DOCKER_BIN || 'docker';
const image = process.env.AOI_BROWSER_IMAGE || 'lscr.io/linuxserver/chromium@sha256:2d32e1b2b28aa92973aa0f58c433c0b045db6e1224d7001eeaa9cde1a474ce13';
const ttl = Number(process.env.AOI_BROWSER_TIMEOUT_SECONDS || 900) * 1000;
const containerName = 'aoi-browser-login-dev';
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isFinite(ttl) || ttl < 30000 || ttl > 1800000) throw new Error('Invalid broker configuration');
await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
await fs.chmod(runtime, 0o700);
const keyPath = path.join(runtime, 'broker.key');
try { await fs.writeFile(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const key = (await fs.readFile(keyPath, 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid broker key');
let session;
let busy = false;
let cleaning;
const peers = new Set();
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a || '').digest(), createHash('sha256').update(b || '').digest());
const run = (args, timeout = 30000) => exec(docker, args, { timeout, maxBuffer: 128 * 1024 });
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const requestOrigin = req => req.socket.encrypted ? publicOrigin : localOrigin;
const validHost = req => req.headers.host === new URL(requestOrigin(req)).host;
const sameOrigin = req => !req.headers.origin || req.headers.origin === requestOrigin(req);
const authenticated = req => session && Date.parse(session.expiresAt) > Date.now() && equal((req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('aoi_browser='))?.slice(12), session.viewerToken);

function cleanup() {
  if (cleaning) return cleaning;
  cleaning = removeSession().finally(() => { cleaning = undefined; });
  return cleaning;
}

async function removeSession() {
  if (!session) return;
  const previous = session;
  clearTimeout(previous.timer);
  for (const peer of peers) peer.destroy();
  if (!previous.containerId) {
    const owned = await run(['ps', '-aq', '--filter', `label=io.aoi.session=${previous.id}`]);
    if (/^[a-f0-9]{12,64}$/.test(owned.stdout.trim())) previous.containerId = owned.stdout.trim();
  }
  if (previous.containerId) {
    try { await run(['rm', '-f', previous.containerId]); }
    catch {
      // --rm or the in-container deadline may already have removed it.
      const remaining = await run(['ps', '-aq', '--filter', `id=${previous.containerId}`]);
      if (remaining.stdout.trim()) throw new Error('cleanup incomplete');
    }
  }
  await fs.rm(previous.envFile, { force: true });
  session = undefined;
}

async function start(input) {
  if (cleaning) await cleaning;
  if (session) await cleanup(); // A restarted AoI has a new PKCE verifier; never reuse its old authorization.
  // Never adopt or delete an existing container, even one with our fixed dev name.
  const existing = await run(['ps', '-aq', '--filter', `name=^/${containerName}$`]);
  if (existing.stdout.trim()) throw new Error('existing container');
  const id = randomUUID();
  const password = randomBytes(32).toString('hex');
  const envFile = path.join(runtime, `${id}.env`);
  await fs.writeFile(envFile, `CUSTOM_USER=aoi\nPASSWORD=${password}\n`, { mode: 0o600, flag: 'wx' });
  session = { id, envFile, password, provider: input.provider, proxyUrl: input.proxyUrl, proxyToken: randomBytes(32).toString('hex'), launchToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex') };
  try {
    const result = await run(['run', '-d', '--rm', '--name', containerName,
      '--label', 'io.aoi.purpose=browser-login-dev', '--log-driver', 'none',
      '--label', `io.aoi.session=${id}`,
      '--security-opt', `seccomp=${path.join(directory, 'seccomp.json')}`,
      '--cpus', '2', '--memory', '3g', '--shm-size', '1g',
      '--tmpfs', '/config:rw,size=768m,mode=1777',
      '--publish', '127.0.0.1::3000', '--env-file', envFile,
      '--env', 'PUID=1000', '--env', 'PGID=1000', '--env', 'TZ=Etc/UTC',
      '--env', 'AUTO_GPU=false', '--env', 'SELKIES_USE_CPU=true|locked',
      '--env', 'SELKIES_ENCODER=jpeg', '--env', 'SELKIES_FRAMERATE=20',
      '--env', 'SELKIES_MANUAL_RESOLUTION=true|locked',
      '--env', `SELKIES_MANUAL_WIDTH=${input.mobile ? 390 : 1280}`, '--env', `SELKIES_MANUAL_HEIGHT=${input.mobile ? 844 : 800}`,
      '--env', 'SELKIES_ENABLE_AUDIO=false|locked', '--env', 'SELKIES_ENABLE_MICROPHONE=false|locked',
      '--env', 'SELKIES_FILE_TRANSFERS=none', '--env', 'SELKIES_COMMAND_ENABLED=false',
      '--env', 'HARDEN_DESKTOP=true', '--env', 'DISABLE_IPV6=true',
      '--mount', `type=bind,source=${directory},target=/opt/aoi,readonly`,
      '--mount', `type=bind,source=${path.join(directory, 'chromium-policy.json')},target=/etc/chromium/policies/managed/aoi-login.json,readonly`,
      '--mount', `type=bind,source=${path.join(directory, 'chromium.sh')},target=/defaults/autostart,readonly`,
      '--mount', `type=bind,source=${path.join(directory, 'chromium.sh')},target=/defaults/autostart_wayland,readonly`,
      image], 120000);
    session.containerId = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(session.containerId)) throw new Error('invalid container');
    // Bound startup as well, including a broker crash before Chromium is ready.
    await run(['exec', '-d', session.containerId, 'sh', '-c', `sleep ${Math.ceil(ttl / 1000) + 90}; /run/s6/basedir/bin/halt`]);
    const init = JSON.stringify({ ...input, proxyUrl: undefined, ttl: Math.ceil(ttl / 1000), brokerPort: port, proxyToken: session.proxyToken });
    await pipeExec(['python3', '-c', 'import sys,os; p="/config/aoi-login.json"; fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); os.write(fd,sys.stdin.buffer.read()); os.close(fd); open("/config/aoi-proxy-enabled","w").close()'], init);
    await run(['exec', '-d', session.containerId, 'python3', '/opt/aoi/container-proxy.py']);
    const mapped = await run(['port', session.containerId, '3000/tcp']);
    const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(mapped.stdout);
    if (!match) throw new Error('invalid port binding');
    session.port = Number(match[1]);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        await run(['exec', session.containerId, 'python3', '-c', 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:9222/json/version",timeout=2).close()'], 4000);
        session.expiresAt = new Date(Date.now() + ttl).toISOString();
        // This deadline survives a broker crash; --rm then discards /config tmpfs.
        await run(['exec', '-d', session.containerId, 'sh', '-c', `sleep ${Math.ceil(ttl / 1000)}; /run/s6/basedir/bin/halt`]);
        const expire = () => void cleanup().catch(() => {
          console.error('Browser cleanup failed; retrying');
          if (session) session.timer = setTimeout(expire, 5000);
        });
        session.timer = setTimeout(expire, ttl);
        // autostart may race /config initialization; ensure the browser uses its local proxy.
        await run(['exec', '-d', session.containerId, 'python3', '/opt/aoi/browser-worker.py']);
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            await new Promise((resolve, reject) => {
              const request = http.get({ host: '127.0.0.1', port: session.port, path: '/', headers: { Authorization: `Basic ${Buffer.from(`aoi:${session.password}`).toString('base64')}` }, timeout: 2000 }, response => { response.resume(); response.statusCode === 200 ? resolve() : reject(new Error()); });
              request.on('error', reject); request.on('timeout', () => request.destroy(new Error()));
            });
            break;
          } catch { if (attempt === 29) throw new Error('stream unavailable'); await new Promise(resolve => setTimeout(resolve, 500)); }
        }
        await fs.rm(envFile, { force: true });
        return session;
      } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    throw new Error('browser unavailable');
  } catch {
    await cleanup();
    throw new Error('browser unavailable');
  }
}

async function pipeExec(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, ['exec', '-i', session.containerId, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let length = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('capture timeout')); }, 15000);
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 65536) { child.kill(); reject(new Error('capture too large')); } else chunks.push(chunk); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('capture failed')); });
    child.on('close', code => { clearTimeout(timer); code ? reject(new Error('capture failed')) : resolve(Buffer.concat(chunks).toString('utf8')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function capture() {
  const result = session.provider === 'pixiv'
    ? await pipeExec(['python3', '-c', 'import pathlib; p=pathlib.Path("/config/aoi-result.json"); print(p.read_text() if p.exists() else "{}")'])
    : await pipeExec(['python3', '/opt/aoi/capture.py']);
  return JSON.parse(result);
}
async function readInput(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new Error('invalid input'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (!['pixiv', 'fanbox'].includes(value.provider) || typeof value.url !== 'string') throw new Error('invalid provider');
  const target = new URL(value.url);
  if (target.protocol !== 'https:' || target.username || target.password ||
    !(value.provider === 'pixiv' ? target.hostname === 'app-api.pixiv.net' && target.pathname === '/web/v1/login' : target.hostname === 'www.fanbox.cc' && target.pathname === '/login')) throw new Error('invalid login URL');
  return value;
}

function upstreamHeaders(req) {
  const headers = { ...req.headers, host: `127.0.0.1:${session.port}`, authorization: `Basic ${Buffer.from(`aoi:${session.password}`).toString('base64')}` };
  delete headers.cookie;
  delete headers['x-aoi-browser-login'];
  return headers;
}

const handleRequest = async (req, res) => {
  if (!validHost(req)) return send(res, 403, { error: 'invalid_host' });
  const url = new URL(req.url, publicOrigin);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok', active: Boolean(session) });
  if (url.pathname.startsWith('/sessions')) {
    // The LAN listener serves only the viewer, never the browser control API.
    if (req.socket.encrypted) return send(res, 404, { error: 'not_found' });
    if (!equal(req.headers.authorization, `Bearer ${key}`)) return send(res, 401, { error: 'unauthorized' });
    if (busy) return send(res, 409, { error: 'busy' });
    busy = true;
    try {
      if (req.method === 'POST' && url.pathname === '/sessions') {
        const value = await start(await readInput(req));
        return send(res, 200, { id: value.id, expiresAt: value.expiresAt, launchToken: value.launchToken });
      }
      const match = /^\/sessions\/([a-f0-9-]{36})(\/capture)?$/.exec(url.pathname);
      if (!match || !session || match[1] !== session.id) return send(res, 410, { error: 'ended' });
      if (Date.parse(session.expiresAt) <= Date.now() && req.method !== 'DELETE') return send(res, 410, { error: 'ended' });
      if (req.method === 'DELETE' && !match[2]) { await cleanup(); return send(res, 200, { closed: true }); }
      if (req.method === 'POST' && match[2]) {
        const result = await capture();
        if (!result.sessionId && !result.code) return send(res, 409, { error: 'not_logged_in' });
        return send(res, 200, result);
      }
      return send(res, 404, { error: 'not_found' });
    } catch { return send(res, 503, { error: 'browser_unavailable' }); }
    finally { busy = false; }
  }
  if (url.pathname === '/open' && req.method === 'GET') {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><meta charset="utf-8"><title>AoI 浏览器登录</title><p id="status">正在连接登录浏览器…</p><script nonce="${nonce}">const token=location.hash.slice(1);history.replaceState(null,'','/open');fetch('/attach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)throw Error();location.replace('/viewer')}).catch(()=>document.getElementById('status').textContent='会话已结束，请返回 AoI 重新打开');</script>`);
  }
  if (url.pathname === '/viewer-state' && req.method === 'GET') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'invalid_origin' });
    return send(res, 200, { active: Boolean(authenticated(req)) });
  }
  if (url.pathname === '/viewer' && req.method === 'GET') {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!authenticated(req) || !sameOrigin(req)) return res.end('<!doctype html><meta charset="utf-8"><p>登录会话已结束，可以关闭此页面。</p>');
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content"><title>AoI 浏览器登录</title><style nonce="${nonce}">html,body{width:100%;height:100%;margin:0;overflow:hidden}body{background:#111827;color:#eee;font:16px system-ui}iframe{position:fixed;top:0;left:0;display:block;width:100%;height:100%;border:0}p{padding:24px}</style><iframe src="/" title="官方登录浏览器" allow="clipboard-read; clipboard-write; fullscreen"></iframe><script nonce="${nonce}">
      const frame=document.querySelector('iframe');
      const fit=()=>{
        // Mobile keyboards can shrink/pan the visual viewport without resizing the layout viewport.
        const viewport=window.visualViewport;
        frame.style.width=(viewport?.width??window.innerWidth)+'px';
        frame.style.height=(viewport?.height??window.innerHeight)+'px';
        frame.style.top=(viewport?.offsetTop??0)+'px';
        frame.style.left=(viewport?.offsetLeft??0)+'px';
        frame.contentWindow?.postMessage({type:'setScaleLocally',value:true},location.origin);
      };
      frame.addEventListener('load',()=>{fit();setTimeout(fit,1000)});
      window.addEventListener('resize',fit);
      window.visualViewport?.addEventListener('resize',fit);
      window.visualViewport?.addEventListener('scroll',fit);
      fit();
      let pending=false;
      const timer=setInterval(async()=>{if(pending)return;pending=true;try{const r=await fetch('/viewer-state',{cache:'no-store'});if(r.ok&&!(await r.json()).active){clearInterval(timer);frame.remove();const p=document.createElement('p');p.textContent='登录会话已结束，可以关闭此页面。请返回 AoI 查看登录结果。';document.body.append(p);window.close()}}catch{}finally{pending=false}},1000);
    </script>`);
  }
  if (url.pathname === '/attach' && req.method === 'POST') {
    if (!sameOrigin(req) || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'invalid_origin' });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1024) { return send(res, 413, { error: 'too_large' }); } chunks.push(chunk); }
    try {
      const { token } = JSON.parse(Buffer.concat(chunks).toString());
      if (!session || typeof token !== 'string' || !equal(token, session.launchToken)) return send(res, 401, { error: 'unauthorized' });
      res.setHeader('Set-Cookie', `aoi_browser=${session.viewerToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(ttl / 1000)}${req.socket.encrypted ? '; Secure' : ''}`);
      return send(res, 200, { connected: true });
    } catch { return send(res, 400, { error: 'invalid_request' }); }
  }
  if (!authenticated(req) || !sameOrigin(req)) return send(res, 401, { error: 'session_required' });
  const proxy = http.request({ host: '127.0.0.1', port: session.port, path: req.url, method: req.method, headers: upstreamHeaders(req) }, upstream => {
    const headers = { ...upstream.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    delete headers['set-cookie'];
    delete headers['www-authenticate'];
    res.writeHead(upstream.statusCode || 502, headers);
    upstream.pipe(res);
  });
  proxy.on('error', () => { if (!res.headersSent) send(res, 502, { error: 'browser_unavailable' }); else res.destroy(); });
  req.pipe(proxy);
};
const server = http.createServer(handleRequest);
const viewerServer = publicOrigin !== localOrigin ? https.createServer({ cert: await fs.readFile(tlsCertFile), key: await fs.readFile(tlsKeyFile) }, handleRequest) : undefined;

server.on('connect', async (req, socket, head) => {
  if (!session || !equal(req.headers['proxy-authorization'], `Bearer ${session.proxyToken}`)) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  try {
    const upstream = await connectViaProxy(req.url, session.proxyUrl);
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head.length) upstream.write(head);
    peers.add(socket); peers.add(upstream);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => { peers.delete(socket); upstream.destroy(); });
    upstream.on('close', () => { peers.delete(upstream); socket.destroy(); });
    socket.pipe(upstream).pipe(socket); upstream.resume();
  } catch { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); }
});

const upgrade = (req, socket, head) => {
  if (!validHost(req) || !authenticated(req) || req.headers.origin !== requestOrigin(req)) { socket.destroy(); return; }
  const upstream = net.connect(session.port, '127.0.0.1', () => {
    const headers = upstreamHeaders(req);
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  peers.add(socket); peers.add(upstream);
  socket.on('close', () => { peers.delete(socket); upstream.destroy(); });
  upstream.on('close', () => { peers.delete(upstream); socket.destroy(); });
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
};
server.on('upgrade', upgrade);
viewerServer?.on('upgrade', upgrade);
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.listen(port, '127.0.0.1', () => console.log(`Browser login broker: ${localOrigin}`));
viewerServer?.listen(Number(publicUrl.port), '0.0.0.0', () => console.log(`Browser login viewer: ${publicOrigin}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close();
  viewerServer?.close();
  void cleanup().then(() => process.exit(0), () => { console.error('Browser cleanup failed'); process.exit(1); });
});
