import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const docker = process.env.DOCKER_BIN || 'docker';
const directory = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(os.tmpdir(), 'aoi-flaresolverr-dev');
const name = 'aoi-flaresolverr-dev';
const label = 'io.aoi.purpose=flaresolverr-dev';
const image = process.env.AOI_FLARESOLVERR_IMAGE || 'aoi-flaresolverr:local';
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
  const seccomp = path.resolve(directory, '../browser-login/seccomp.json');
  const args = ['build', '--tag', image];
  if (process.env.AOI_FLARESOLVERR_BASE_IMAGE) args.push('--build-arg', `BASE_IMAGE=${process.env.AOI_FLARESOLVERR_BASE_IMAGE}`);
  if (process.env.AOI_FLARESOLVERR_IMAGE) {
    await exec(docker, ['image', 'inspect', '--format', '{{.Id}}', image]);
  } else {
    console.log('Building the pinned FlareSolverr image with the FANBOX supplement…');
    await exec(docker, [...args, directory], { maxBuffer: 4 * 1024 * 1024 });
  }
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
