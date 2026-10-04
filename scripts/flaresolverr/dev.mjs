import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const docker = process.env.DOCKER_BIN || 'docker';
const directory = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(os.tmpdir(), 'aoi-flaresolverr-dev');
const name = 'aoi-flaresolverr-dev';
const label = 'io.aoi.purpose=flaresolverr-dev';
const image = 'aoi-flaresolverr:local';
const command = process.argv[2] || 'status';

async function ownedContainer() {
  const result = await exec(docker, ['ps', '-aq', '--filter', `name=^/${name}$`]);
  if (!result.stdout.trim()) return false;
  const inspection = JSON.parse((await exec(docker, ['inspect', name])).stdout)[0];
  if (inspection.Config.Labels?.['io.aoi.purpose'] !== 'flaresolverr-dev') throw new Error('Container name belongs to another service');
  return true;
}

if (command === 'up') {
  if (await ownedContainer()) throw new Error('Dedicated container already exists; use status or down first');
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(43132, '127.0.0.1', resolve); });
  await new Promise(resolve => listener.close(resolve));
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  // Preserve Docker's default seccomp policy, adding only namespace calls needed by Chromium's sandbox.
  const upstream = 'https://raw.githubusercontent.com/moby/profiles/2ceae35d351c156cb5a8efc0fdc4a08cf94569d8/seccomp/default.json';
  const original = path.join(runtime, 'seccomp-default.json');
  const curlArgs = ['--fail', '--silent', '--show-error', '--max-time', '30', '--output', original];
  if (process.env.AOI_PROXY_URL) {
    const proxy = new URL(process.env.AOI_PROXY_URL);
    if (proxy.username || proxy.password) throw new Error('Local image preparation requires a proxy without URL credentials');
    curlArgs.push('--proxy', process.env.AOI_PROXY_URL);
  }
  await exec('curl', [...curlArgs, upstream]);
  const bytes = await fs.readFile(original);
  const profile = JSON.parse(bytes.toString('utf8'));
  if (createHash('sha256').update(bytes).digest('hex') !== '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6') throw new Error('Unexpected upstream seccomp profile');
  profile.syscalls.push({ names: ['clone', 'unshare', 'setns'], action: 'SCMP_ACT_ALLOW', args: [] });
  const seccomp = path.join(runtime, 'seccomp.json');
  await fs.writeFile(seccomp, JSON.stringify(profile), { mode: 0o600 });
  const args = ['build', '--tag', image];
  if (process.env.AOI_FLARESOLVERR_BASE_IMAGE) args.push('--build-arg', `BASE_IMAGE=${process.env.AOI_FLARESOLVERR_BASE_IMAGE}`);
  console.log('Building the pinned FlareSolverr image with the FANBOX supplement…');
  await exec(docker, [...args, directory], { maxBuffer: 4 * 1024 * 1024 });
  await exec(docker, ['run', '-d', '--rm', '--name', name, '--label', label,
    '--publish', '127.0.0.1:43132:8191', '--cpus', '2', '--memory', '1536m', '--shm-size', '256m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--tmpfs', '/config:rw,nosuid,nodev,size=64m,uid=1000,gid=1000',
    '--security-opt', `seccomp=${seccomp}`, '--log-driver', 'none', image]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:43132/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === 'ok') {
        console.log('FlareSolverr ready: http://127.0.0.1:43132 (loopback control only)');
        process.exit(0);
      }
    } catch { /* Wait for the browser installation check. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await exec(docker, ['stop', name]);
  throw new Error('FlareSolverr failed its local health check; container removed');
} else if (command === 'down') {
  if (await ownedContainer()) await exec(docker, ['stop', name]);
  // This directory contains only downloaded public seccomp configuration, never credentials.
  for (const file of ['seccomp-default.json', 'seccomp.json']) await fs.rm(path.join(runtime, file), { force: true });
  await fs.rmdir(runtime).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log('Dedicated solver removed; AoI data and cached Docker images retained.');
} else if (command === 'status') {
  if (!await ownedContainer()) console.log('FlareSolverr: stopped');
  else {
    const response = await fetch('http://127.0.0.1:43132/health', { signal: AbortSignal.timeout(2000) });
    console.log(`FlareSolverr: ${response.status}`);
    console.log((await exec(docker, ['stats', '--no-stream', '--format', '{{.Name}} CPU={{.CPUPerc}} Memory={{.MemUsage}}', name])).stdout.trim());
  }
} else throw new Error('Usage: node scripts/flaresolverr/dev.mjs up|status|down');
