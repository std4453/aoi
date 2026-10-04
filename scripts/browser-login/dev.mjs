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
if (command === 'up' || command === 'restart') {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Use Node.js 22 for the local AoI test');
  let previous;
  if (command === 'restart') {
    previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (path.dirname(previous.dataDir) !== runtime || !path.basename(previous.dataDir).startsWith('data-')) throw new Error('Unexpected test directory');
    await stopProcess(previous.appPid, 'server/dist/server/src/index.js');
    await stopProcess(previous.brokerPid, 'scripts/browser-login/broker.mjs');
  } else {
    try { await fs.access(statePath); throw new Error('Existing test runtime: run status, restart or down first'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const lanIp = process.env.AOI_BROWSER_LAN_IP ?? previous?.lanIp ?? '';
  if (lanIp && !(net.isIPv4(lanIp) && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(lanIp))) throw new Error('AOI_BROWSER_LAN_IP must be this machine private IPv4 address');
  const host = lanIp ? '0.0.0.0' : '127.0.0.1';
  const viewerOrigin = lanIp ? `https://${lanIp}:43130` : 'http://127.0.0.1:43129';
  await exec(docker, ['info', '--format', '{{.Architecture}}']);
  await freePort(43127, host); await freePort(43129);
  if (lanIp) await freePort(43130, host);
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
  const brokerLog = await fs.open(path.join(runtime, 'broker.log'), 'a', 0o600);
  const appLog = await fs.open(path.join(runtime, 'aoi.log'), 'a', 0o600);
  const broker = spawn(process.execPath, [path.join(root, 'scripts/browser-login/broker.mjs')], {
    detached: true, stdio: ['ignore', brokerLog.fd, brokerLog.fd],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_BIN: docker, AOI_BROWSER_RUNTIME: runtime, AOI_BROWSER_IMAGE: process.env.AOI_BROWSER_IMAGE,
      AOI_BROWSER_TIMEOUT_SECONDS: process.env.AOI_BROWSER_TIMEOUT_SECONDS || '900',
      AOI_BROWSER_PUBLIC_ORIGIN: viewerOrigin, AOI_BROWSER_TLS_CERT_FILE: lanIp ? certPath : undefined, AOI_BROWSER_TLS_KEY_FILE: lanIp ? privateKeyPath : undefined },
  });
  broker.unref();
  const app = spawn(process.execPath, [path.join(root, 'server/dist/server/src/index.js')], {
    cwd: root, detached: true, stdio: ['ignore', appLog.fd, appLog.fd],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', DATA_DIR: dataDir,
      HOST: host, PORT: '43127', AUTH_KEY: authKey, AOI_SNAPSHOT_ENABLED: 'false', SERVER_SELECTION_ENABLED: 'false',
      AOI_BROWSER_LOGIN_URL: 'http://127.0.0.1:43129', AOI_BROWSER_LOGIN_PUBLIC_URL: viewerOrigin,
      AOI_BROWSER_LOGIN_KEY_FILE: path.join(runtime, 'broker.key'),
      AOI_FLARESOLVERR_URL: process.env.AOI_FLARESOLVERR_URL || '', AOI_FLARESOLVERR_PROXY_URL: process.env.AOI_FLARESOLVERR_PROXY_URL || '',
      FANBOX_SESSION_ID: '', FANBOX_COOKIES_FILE: '', PIXIV_REFRESH_TOKEN: '', PIXIV_COOKIE: '', AOI_PROXY_URL: process.env.AOI_PROXY_URL || '', PIXIV_PROXY_URL: process.env.PIXIV_PROXY_URL || '',
    },
  });
  app.unref();
  await fs.writeFile(statePath, JSON.stringify({ appPid: app.pid, brokerPid: broker.pid, dataDir, lanIp }), { flag: command === 'restart' ? 'w' : 'wx', mode: 0o600 });
  await brokerLog.close(); await appLog.close();
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      process.kill(app.pid, 0); process.kill(broker.pid, 0);
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
  for (const [pid, marker] of [[state.appPid, 'server/dist/server/src/index.js'], [state.brokerPid, 'scripts/browser-login/broker.mjs']]) {
    try {
      const info = await exec('ps', ['-p', String(pid), '-o', 'args=']);
      if (!info.stdout.includes(path.join(root, marker))) throw new Error('PID belongs to another process');
      process.kill(pid, 'SIGTERM');
    } catch (error) { if (error.code !== 1 && error.code !== 'ESRCH') throw error; }
  }
  for (let i = 0; i < 60; i++) {
    const result = await exec(docker, ['ps', '-aq', '--filter', 'label=io.aoi.purpose=browser-login-dev']);
    if (!result.stdout.trim()) break;
    if (i === 59) throw new Error('Browser cleanup incomplete; dedicated runtime retained');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  for (const pid of [state.appPid, state.brokerPid]) {
    for (let i = 0; i < 60; i++) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (i === 59) throw new Error('Test process still stopping; dedicated runtime retained');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  // Remove only artifacts created by this launcher, never unrelated directories or Docker volumes.
  await fs.rm(state.dataDir, { recursive: true, force: true });
  for (const name of ['broker.key', 'broker.log', 'aoi.log', 'dev.json', 'lan-access.txt', 'mobile-access.md', 'viewer.crt', 'viewer.key', 'viewer-cert.cnf']) await fs.rm(path.join(runtime, name), { force: true });
  await fs.rmdir(runtime);
  console.log('Dedicated AoI data, credentials and browser session removed. Docker Desktop and cached image retained.');
} else throw new Error('Usage: node scripts/browser-login/dev.mjs up|restart|status|down');
