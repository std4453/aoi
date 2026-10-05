import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import sharp from 'sharp';
import { contractValues, makeManifest } from '~/replication/protocol';
import { startTestServer, stopTestServer, type TestServer } from './helpers/server-process';

test('a fresh replica becomes readable while later packs are still downloading', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-first-readable-'));
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#2277cc' } }).png().toBuffer();
  const manifests = ['first', 'second'].map(id => makeManifest({
    id, name: id, originalFilename: 'folder', originalSize: 0, originalFormat: 'folder', sourceType: 'folder',
    status: 'extracted', imageCount: 1, videoCount: 0, totalImagesSize: png.length, totalVideosSize: 0,
    errorMessage: null, archivePassword: null, compressedSize: 0, tags: [], createdAt: '2026-10-03', updatedAt: '2026-10-03',
  }, [{ path: 'images/test.png', size: png.length, hash: createHash('sha256').update(png).digest('hex') }]));
  const index = { ...contractValues(), datasetId: randomUUID(), packs: manifests.map(manifest => ({
    id: manifest.metadata.id, state: 'ready', revision: manifest.revision,
  })) };
  const downloads = new Map<string, ServerResponse>();
  const source = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/api/health') {
      response.end(JSON.stringify({ service: 'aoi', writable: true, replicationProtocol: '1.0.0', capabilities: { snapshots: true } }));
    } else if (url.pathname === '/api/packs/snapshot') {
      response.end(JSON.stringify(index));
    } else {
      const manifest = manifests.find(item => url.pathname.startsWith(`/api/packs/${item.metadata.id}/snapshot`));
      if (!manifest) { response.writeHead(404).end(); return; }
      if (url.pathname.includes('/files/')) downloads.set(manifest.metadata.id, response);
      else response.end(JSON.stringify(manifest));
    }
  });
  let replica: TestServer | undefined;
  async function eventually(check: () => Promise<boolean>, message: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(message);
  }
  try {
    source.listen(0, '127.0.0.1');
    await once(source, 'listening');
    const port = (source.address() as { port: number }).port;
    replica = await startTestServer(dir, true, { AOI_REPLICA_SOURCE_URL: `http://127.0.0.1:${port}`, AOI_REPLICATION_INTERVAL: '5' });
    const status = async () => await (await fetch(`${replica!.url}/api/system/replication`)).json() as {
      ready: boolean; running: boolean; lastSuccess: string | null;
    };
    await eventually(async () => downloads.has('first'), 'first download did not start');
    assert.equal((await fetch(`${replica.url}/api/packs`)).status, 503);
    downloads.get('first')!.end(png);
    await eventually(async () => downloads.has('second'), 'second download did not start');
    await eventually(async () => (await status()).ready, 'first pack must become readable before the second download finishes');
    assert.equal((await status()).running, true);
    assert.equal((await status()).lastSuccess, null);
    assert.equal((await fetch(`${replica.url}/api/packs`)).status, 200);
    assert.equal((await fetch(`${replica.url}/api/packs/first/cover`)).status, 200);
    downloads.get('second')!.end(png);
    await eventually(async () => Boolean((await status()).lastSuccess), 'first synchronization did not finish');
  } finally {
    if (replica) await stopTestServer(replica);
    source.closeAllConnections();
    await new Promise<void>(resolve => source.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
