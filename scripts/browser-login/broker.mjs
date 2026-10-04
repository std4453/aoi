import http from 'node:http';
import https from 'node:https';
import { connectViaProxy } from './proxy-tunnel.mjs';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchSession } from './session-runtime.mjs';

const exec = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.AOI_BROWSER_PORT || 43129);
const viewerPort = Number(process.env.AOI_BROWSER_VIEWER_PORT || 43130);
const publicOrigin = process.env.AOI_BROWSER_PUBLIC_ORIGIN || 'http://127.0.0.1:43130';
const publicUrl = new URL(publicOrigin);
const tlsCertFile = process.env.AOI_BROWSER_TLS_CERT_FILE;
const tlsKeyFile = process.env.AOI_BROWSER_TLS_KEY_FILE;
if (publicUrl.origin !== publicOrigin || publicUrl.username || publicUrl.password ||
    !(publicUrl.protocol === 'https:' || publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname))) throw new Error('Invalid public viewer origin');
if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) throw new Error('Configure both viewer TLS files');
const ttl = Number(process.env.AOI_BROWSER_TIMEOUT_SECONDS || 900) * 1000;
if (![port, viewerPort].every(value => Number.isInteger(value) && value > 1023 && value <= 65535) || port === viewerPort || !Number.isFinite(ttl) || ttl < 30000 || ttl > 1800000) throw new Error('Invalid broker configuration');
const key = (await fs.readFile(process.env.AOI_BROWSER_KEY_FILE || '/run/secrets/browser-key', 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid broker key');
const proxyOverride = process.env.AOI_BROWSER_PROXY_FILE
  ? JSON.parse(await fs.readFile(process.env.AOI_BROWSER_PROXY_FILE, 'utf8')) : undefined;
let session;
let busy = false;
let cleaning;
let unhealthy = false;
const peers = new Set();
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a || '').digest(), createHash('sha256').update(b || '').digest());
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const validHost = req => req.headers.host === publicUrl.host;
const sameOrigin = req => !req.headers.origin || req.headers.origin === publicOrigin;
const authenticated = req => session && Date.parse(session.expiresAt) > Date.now() && equal((req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('aoi_browser='))?.slice(12), session.viewerToken);
const closePeers = () => { for (const peer of peers) peer.destroy(); };

function cleanup() {
  if (cleaning) return cleaning;
  cleaning = removeSession().finally(() => { cleaning = undefined; });
  return cleaning;
}
async function removeSession() {
  const previous = session;
  if (!previous) return;
  previous.expiresAt = new Date(0).toISOString();
  closePeers();
  try {
    await previous.runtime.close();
    if (session === previous) session = undefined;
  } catch { unhealthy = true; throw new Error('cleanup incomplete'); }
}
async function start(input) {
  if (unhealthy) throw new Error('browser cleanup incomplete');
  if (cleaning) await cleaning;
  if (session) await cleanup();
  const current = { id: randomUUID(), provider: input.provider, port: 3000,
    proxyUrl: proxyOverride?.[input.provider] ?? input.proxyUrl, expiresAt: new Date(Date.now() + 90000).toISOString(),
    launchToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex') };
  session = current;
  current.runtime = launchSession({ ...input, proxyUrl: undefined, ttl: ttl / 1000 }, clean => {
    if (!clean) unhealthy = true;
    if (session === current) { closePeers(); current.expiresAt = new Date(0).toISOString(); }
  });
  try {
    await current.runtime.ready;
    const response = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error('stream unavailable');
    current.expiresAt = new Date(Date.now() + ttl).toISOString();
    return current;
  } catch { await cleanup(); throw new Error('browser unavailable'); }
}
async function capture() {
  if (session.provider === 'pixiv') {
    try { return JSON.parse(await fs.readFile('/run/aoi/session/result.json', 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  // stdout is a private bounded IPC result, never a log.
  const result = await exec('python3', [path.join(directory, 'capture.py')], { timeout: 15000, maxBuffer: 32768 });
  return JSON.parse(result.stdout);
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
  const headers = { ...req.headers, host: `127.0.0.1:${session.port}` };
  delete headers.cookie;
  delete headers.authorization;
  delete headers['proxy-authorization'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  delete headers['x-aoi-browser-login'];
  return headers;
}

const handleRequest = async (req, res, control = false) => {
  if (!control && !validHost(req)) return send(res, 403, { error: 'invalid_host' });
  const url = new URL(req.url, publicOrigin);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (control && url.pathname === '/health' && req.method === 'GET') return send(res, unhealthy ? 503 : 200, { status: unhealthy ? 'unavailable' : 'ok', active: Boolean(session && Date.parse(session.expiresAt) > Date.now()) });
  if (url.pathname.startsWith('/sessions')) {
    // Listener identity is explicit; never trust X-Forwarded-* to grant control access.
    if (!control) return send(res, 404, { error: 'not_found' });
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
  if (control) return send(res, 404, { error: 'not_found' });
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
      if (!session || Date.parse(session.expiresAt) <= Date.now() || typeof token !== 'string' || !equal(token, session.launchToken)) return send(res, 401, { error: 'unauthorized' });
      res.setHeader('Set-Cookie', `aoi_browser=${session.viewerToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(ttl / 1000)}${publicUrl.protocol === 'https:' ? '; Secure' : ''}`);
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
// Reset interrupted sessions before exposing readiness (e.g. s6 restarts the broker).
await exec('python3', [path.join(directory, 'session-runner.py'), 'reset'], { timeout: 45000 });
const safeHandle = control => (req, res) => { void handleRequest(req, res, control).catch(() => {
  if (!res.headersSent) send(res, 503, { error: 'browser_unavailable' }); else res.destroy();
}); };
const server = http.createServer(safeHandle(true));
const viewerServer = tlsCertFile
  ? https.createServer({ cert: await fs.readFile(tlsCertFile), key: await fs.readFile(tlsKeyFile) }, safeHandle(false))
  : http.createServer(safeHandle(false));
// This proxy binds only container loopback. Browsers use no upstream credentials.
const proxyServer = http.createServer((req, res) => send(res, 405, { error: 'https_required' }));
proxyServer.on('connect', async (req, socket, head) => {
  const current = session;
  if (!current || Date.parse(current.expiresAt) <= Date.now()) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  try {
    const upstream = await connectViaProxy(req.url, current.proxyUrl);
    if (session !== current || Date.parse(current.expiresAt) <= Date.now()) { upstream.destroy(); socket.destroy(); return; }
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
  if (!validHost(req) || !authenticated(req) || req.headers.origin !== publicOrigin) { socket.destroy(); return; }
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
server.on('upgrade', (_req, socket) => socket.destroy());
server.on('connect', (_req, socket) => socket.destroy());
viewerServer.on('upgrade', upgrade);
viewerServer.on('connect', (_req, socket) => socket.destroy());
for (const listener of [server, viewerServer, proxyServer]) {
  listener.requestTimeout = 20000;
  listener.headersTimeout = 10000;
}
server.listen(port, '0.0.0.0', () => console.log('Browser control service ready'));
viewerServer.listen(viewerPort, '0.0.0.0', () => console.log('Browser viewer ready'));
proxyServer.listen(9223, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(); viewerServer.close(); proxyServer.close();
  void cleanup().then(() => process.exit(0), () => { console.error('Browser cleanup failed'); process.exit(1); });
});
