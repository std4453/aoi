import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { startTestServer, stopTestServer, waitForExit } from './helpers/server-process.js';

const origin = 'https://frontend.example.com';

test('auth protects APIs, resources and tus before parsing, and supports cross-origin access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-auth-'));
  const server = await startTestServer(dir, true, { AUTH_KEY: 'private-key' });
  try {
    const health = await fetch(`${server.url}/api/health`);
    const capability = await health.json() as { status: string; service: string; authRequired: boolean; writable: boolean; role: string };
    assert.equal(capability.status, 'ok');
    assert.equal(capability.service, 'aoi');
    assert.equal(capability.authRequired, true);
    assert.equal(capability.writable, true);
    assert.equal(capability.role, 'off');
    assert.equal(fs.existsSync(path.join(dir, 'replication')), false);
    for (const route of ['/api/packs', '/api/system/disk-space', '/api/packs/missing/cover', '/api/packs/missing/images/a.jpg', '/api/packs/missing/download', '/api/jobs/missing/events']) {
      assert.equal((await fetch(server.url + route)).status, 401, route);
    }
    const rejected = await fetch(`${server.url}/api/upload/files`, { method: 'POST', headers: { Origin: origin, 'Tus-Resumable': '1.0.0', 'Upload-Length': '3' } });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('access-control-allow-origin'), origin);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'uploads')), []);
    const preflight = await fetch(`${server.url}/api/upload/files`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,tus-resumable,upload-offset,content-type' } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /PATCH/);
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/i);
    assert.equal((await fetch(`${server.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'bad' }) })).status, 401);
    const login = await fetch(`${server.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'private-key' }) });
    const { token } = await login.json() as { token: string };
    assert.notEqual(token, 'private-key');
    const headers = { Authorization: `Bearer ${token}`, Origin: origin };
    assert.equal((await fetch(`${server.url}/api/packs`, { headers })).status, 200);
    assert.equal((await fetch(`${server.url}/api/packs?access_token=${token}`)).status, 401);
    assert.equal((await fetch(`${server.url}/api/packs/missing/cover?access_token=${token}`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/packs/missing/cover?access_token=${token}`, { method: 'HEAD' })).status, 404);
    const upload = await fetch(`${server.url}/api/upload/files`, { method: 'POST', headers: { ...headers, 'Tus-Resumable': '1.0.0', 'Upload-Length': '3' } });
    assert.equal(upload.status, 201);
    assert.ok(upload.headers.get('access-control-allow-origin'));
    const location = new URL(upload.headers.get('location')!, server.url);
    const chunk = await fetch(location, { method: 'PATCH', headers: { ...headers, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: 'abc' });
    assert.equal(chunk.status, 204);
    assert.equal(chunk.headers.get('upload-offset'), '3');
    assert.equal((await fetch(location, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } })).status, 401);
    assert.equal((await fetch(location, { method: 'DELETE', headers: { ...headers, 'Tus-Resumable': '1.0.0' } })).status, 204);
    assert.ok(!server.output().includes(token));
    assert.ok(!server.output().includes('private-key'));
  } finally {
    await stopTestServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('frontend-only mode exposes runtime flags without initializing any data or API', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-frontend-'));
  const dir = path.join(parent, 'unused');
  const server = await startTestServer(dir, true, { FRONTEND_ONLY: 'true', SERVER_SELECTION_ENABLED: 'true', AUTH_KEY: 'never-expose', AOI_REPLICATION_ROLE: 'primary' });
  try {
    const config = await fetch(`${server.url}/runtime-config.json`);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await config.json(), { serverSelectionEnabled: true });
    for (const route of ['/api/health', '/api/packs', '/api/auth/login', '/api/upload/files']) {
      assert.equal((await fetch(server.url + route)).status, 404);
    }
    assert.equal(fs.existsSync(dir), false);
  } finally {
    await stopTestServer(server);
    assert.equal(fs.existsSync(dir), false);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

function tlsGet(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
}

test('built-in TLS loads external certificates; partial TLS configuration fails closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-tls-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const server = await startTestServer(path.join(dir, 'data'), false, { FRONTEND_ONLY: 'true', TLS_CERT_FILE: cert, TLS_KEY_FILE: key });
  try {
    let status: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { status = await tlsGet(server.port); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(status, 200, server.output());
    execFileSync(process.execPath, ['healthcheck.cjs'], { env: { ...process.env, PORT: String(server.port), TLS_CERT_FILE: cert } });
  } finally { await stopTestServer(server); }
  const invalid = await startTestServer(path.join(dir, 'data'), false, { TLS_CERT_FILE: cert, TLS_KEY_FILE: '' });
  try {
    assert.notEqual(await waitForExit(invalid), 0);
    assert.match(invalid.output(), /must be configured together/);
    assert.equal(fs.existsSync(path.join(dir, 'data')), false);
  } finally {
    await stopTestServer(invalid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
