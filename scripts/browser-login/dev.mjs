import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = path.resolve(process.env.AOI_BROWSER_RUNTIME || '/tmp/aoi-browser-login-dev');
const statePath = path.join(runtime, 'dev.json');
const exec = promisify(execFile);
const docker = process.env.DOCKER_BIN || 'docker';
const command = process.argv[2] || 'status';
const containerName = 'aoi-browser-service-dev';

async function freePort(port, host = '127.0.0.1') {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, host, resolve); });
  await new Promise(resolve => listener.close(resolve));
}
async function stopProcess(pid, marker) {
  try {
    const info = await exec('ps', ['-p', String(pid), '-o', 'args=']);
    if (!info.stdout.includes(path.join(root, marker))) throw new Error('PID belongs to another process');
    process.kill(pid, 'SIGTERM');
  } catch (error) { if (error.code === 1 || error.code === 'ESRCH') return; throw error; }
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Test process is still stopping');
}
async function stopContainer(id) {
  if (!id) return;
  let info;
  try { info = JSON.parse((await exec(docker, ['inspect', '--format', '{{json .}}', id], { maxBuffer: 256 * 1024 })).stdout); }
  catch (error) { if (/No such (object|container)/.test(error.stderr || '')) return; throw error; }
  if (info.Config.Labels?.['io.aoi.workspace'] !== root || info.Name !== `/${containerName}`) throw new Error('Container belongs to another runtime');
  await exec(docker, ['stop', '-t', '50', id], { timeout: 60000 });
  await exec(docker, ['rm', id]);
}
async function stopRuntime(state) {
  await stopProcess(state.appPid, 'server/dist/server/src/index.js');
  if (state.brokerPid) await stopProcess(state.brokerPid, 'scripts/browser-login/broker.mjs'); // Migrate the previous local launcher.
  await stopContainer(state.containerId);
}
function containerProxy(value) {
  if (!value) return '';
  const url = new URL(value);
  // Only the local development launcher translates its host-local proxy.
  // Production uses an explicit address reachable from the browser container.
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  return url.href;
}
if (command === 'up' || command === 'restart') {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Use Node.js 22 for the local AoI test');
  let previous;
  if (command === 'restart') {
    previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (path.dirname(previous.dataDir) !== runtime || !path.basename(previous.dataDir).startsWith('data-')) throw new Error('Unexpected test directory');
    await stopRuntime(previous);
  } else {
    try { await fs.access(statePath); throw new Error('Existing test runtime: run status, restart or down first'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const image = process.env.AOI_BROWSER_IMAGE || previous?.image || 'aoi-browser-login:local';
  // Reuse only our explicit dev configuration when restarting; never fall back
  // to another AoI instance's settings or daily browser state.
  const proxyUrl = process.env.AOI_PROXY_URL ?? previous?.proxyUrl ?? '';
  const pixivProxyUrl = process.env.PIXIV_PROXY_URL ?? previous?.pixivProxyUrl ?? '';
  const flaresolverrUrl = process.env.AOI_FLARESOLVERR_URL ?? previous?.flaresolverrUrl ?? '';
  const flaresolverrProxyUrl = process.env.AOI_FLARESOLVERR_PROXY_URL ?? previous?.flaresolverrProxyUrl ?? '';
  const lanIp = process.env.AOI_BROWSER_LAN_IP ?? previous?.lanIp ?? '';
  if (lanIp && !(net.isIPv4(lanIp) && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(lanIp))) throw new Error('AOI_BROWSER_LAN_IP must be this machine private IPv4 address');
  const host = lanIp ? '0.0.0.0' : '127.0.0.1';
  const viewerOrigin = lanIp ? `https://${lanIp}:43130` : 'http://127.0.0.1:43130';
  await exec(docker, ['info', '--format', '{{.Architecture}}']);
  await freePort(43127, host); await freePort(43129);
  await freePort(43130, host);
  const existing = await exec(docker, ['ps', '-aq', '--filter', `name=^/${containerName}$`]);
  if (existing.stdout.trim()) throw new Error('Existing browser service was not created by this runtime');
  await fs.access(path.join(root, 'server/dist/server/src/index.js'));
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  const dataDir = previous?.dataDir || await fs.mkdtemp(path.join(runtime, 'data-'));
  let authKey = '';
  const certPath = path.join(runtime, 'viewer.crt');
  const privateKeyPath = path.join(runtime, 'viewer.key');
  if (lanIp) {
    const accessPath = path.join(runtime, 'lan-access.txt');
    try { await fs.writeFile(accessPath, randomBytes(18).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    authKey = (await fs.readFile(accessPath, 'utf8')).trim();
    if (!authKey) throw new Error('Missing LAN access key');
    // Dedicated one-day leaf certificate, never installed as a root CA.
    const certificateConfig = path.join(runtime, 'viewer-cert.cnf');
    await fs.writeFile(certificateConfig, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=AoI local browser\n[ext]\nsubjectAltName=IP:${lanIp},IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    let certificateValid = false;
    if (previous?.lanIp === lanIp) {
      try { await exec('openssl', ['x509', '-in', certPath, '-checkend', '3600', '-noout']); await fs.access(privateKeyPath); certificateValid = true; }
      catch { /* Generate a new dedicated leaf when absent or about to expire. */ }
    }
    if (!certificateValid) await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', privateKeyPath, '-out', certPath, '-config', certificateConfig]);
    await fs.chmod(privateKeyPath, 0o600);
  }
  const keyPath = path.join(runtime, 'broker.key');
  try { await fs.writeFile(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Keep secrets in mounted 0600 files, never docker arguments or logs.
  const proxyFile = path.join(runtime, 'browser-proxy.json');
  await fs.writeFile(proxyFile, JSON.stringify({
    fanbox: containerProxy(proxyUrl),
    pixiv: containerProxy(pixivProxyUrl || proxyUrl),
  }), { mode: 0o600 });
  const args = ['run', '-d', '--name', containerName, '--label', `io.aoi.workspace=${root}`,
    '--log-driver', 'none', '--security-opt', `seccomp=${path.join(root, 'scripts/browser-login/seccomp.json')}`,
    '--cpus', '2', '--memory', '3g', '--shm-size', '1g',
    '--tmpfs', '/config:rw,size=768m,mode=1777', '--tmpfs', '/run/aoi:rw,size=16m,mode=700',
    '--publish', '127.0.0.1:43129:43129', '--publish', `${host}:43130:43130`,
    '--add-host', 'host.docker.internal:host-gateway',
    '--mount', `type=bind,source=${keyPath},target=/run/secrets/browser-key,readonly`,
    '--mount', `type=bind,source=${proxyFile},target=/run/secrets/browser-proxy.json,readonly`,
    '--env', 'AOI_BROWSER_PROXY_FILE=/run/secrets/browser-proxy.json',
    '--env', `AOI_BROWSER_PUBLIC_ORIGIN=${viewerOrigin}`,
    '--env', `AOI_BROWSER_TIMEOUT_SECONDS=${process.env.AOI_BROWSER_TIMEOUT_SECONDS || '900'}`];
  if (lanIp) args.push('--mount', `type=bind,source=${certPath},target=/run/secrets/viewer.crt,readonly`,
    '--mount', `type=bind,source=${privateKeyPath},target=/run/secrets/viewer.key,readonly`,
    '--env', 'AOI_BROWSER_TLS_CERT_FILE=/run/secrets/viewer.crt', '--env', 'AOI_BROWSER_TLS_KEY_FILE=/run/secrets/viewer.key');
  args.push(image);
  const containerId = (await exec(docker, args, { timeout: 120000 })).stdout.trim();
  const appLog = await fs.open(path.join(runtime, 'aoi.log'), 'a', 0o600);
  const app = spawn(process.execPath, [path.join(root, 'server/dist/server/src/index.js')], {
    cwd: root, detached: true, stdio: ['ignore', appLog.fd, appLog.fd],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', DATA_DIR: dataDir,
      HOST: host, PORT: '43127', AUTH_KEY: authKey, AOI_SNAPSHOT_ENABLED: 'false', SERVER_SELECTION_ENABLED: 'false',
      AOI_BROWSER_LOGIN_URL: 'http://127.0.0.1:43129', AOI_BROWSER_LOGIN_PUBLIC_URL: viewerOrigin,
      AOI_BROWSER_LOGIN_KEY_FILE: path.join(runtime, 'broker.key'),
      AOI_FLARESOLVERR_URL: flaresolverrUrl, AOI_FLARESOLVERR_PROXY_URL: flaresolverrProxyUrl,
      FANBOX_SESSION_ID: '', FANBOX_COOKIES_FILE: '', PIXIV_REFRESH_TOKEN: '', PIXIV_COOKIE: '', AOI_PROXY_URL: proxyUrl, PIXIV_PROXY_URL: pixivProxyUrl,
    },
  });
  app.unref();
  await fs.writeFile(statePath, JSON.stringify({ appPid: app.pid, containerId, image, dataDir, lanIp, proxyUrl, pixivProxyUrl, flaresolverrUrl, flaresolverrProxyUrl }), { flag: command === 'restart' ? 'w' : 'wx', mode: 0o600 });
  await appLog.close();
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      process.kill(app.pid, 0);
      const appReady = await fetch('http://127.0.0.1:43127/healthz', { signal: AbortSignal.timeout(1000) });
      const brokerReady = await fetch('http://127.0.0.1:43129/health', { signal: AbortSignal.timeout(1000) });
      if (appReady.ok && brokerReady.ok) { ready = true; break; }
    } catch { /* Allow both dedicated processes to finish starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Local test services did not become ready; inspect dedicated logs, then run down');
  console.log(`AoI: http://${lanIp || '127.0.0.1'}:43127/settings`);
  if (lanIp) console.log(`LAN access key file: ${path.join(runtime, 'lan-access.txt')}`);
  console.log(`Dedicated test data: ${dataDir}`);
} else if (command === 'status') {
  for (const [name, url] of [['AoI', 'http://127.0.0.1:43127/healthz'], ['Browser broker', 'http://127.0.0.1:43129/health']]) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); console.log(`${name}: ${response.status}`); }
    catch { console.log(`${name}: stopped`); }
  }
} else if (command === 'down') {
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (path.dirname(state.dataDir) !== runtime || !path.basename(state.dataDir).startsWith('data-')) throw new Error('Unexpected test directory');
  await stopRuntime(state);
  // Remove only artifacts created by this launcher, never unrelated directories or Docker volumes.
  await fs.rm(state.dataDir, { recursive: true, force: true });
  for (const name of ['browser-proxy.json', 'broker.key', 'broker.log', 'aoi.log', 'dev.json', 'lan-access.txt', 'mobile-access.md', 'viewer.crt', 'viewer.key', 'viewer-cert.cnf']) await fs.rm(path.join(runtime, name), { force: true });
  await fs.rmdir(runtime);
  console.log('Dedicated AoI data, credentials and browser service removed. Docker Desktop and cached image retained.');
} else throw new Error('Usage: node scripts/browser-login/dev.mjs up|restart|status|down');
