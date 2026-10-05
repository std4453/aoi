import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { startTestServer, stopTestServer } from './helpers/server-process';

test('malformed MEGA metadata fails the request without taking down the server', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-mega-metadata-errors-'));
  const preload = path.join(directory, 'network.mjs');
  const key = Buffer.alloc(32, 0x13);
  const attribute = Buffer.from('MEGA{"n":"fixture.zip"}');
  const padded = Buffer.alloc(Math.ceil(attribute.length / 16) * 16);
  attribute.copy(padded);
  const cipher = createCipheriv('aes-128-cbc', Buffer.alloc(16), Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const valid = { s: 4, at: Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64url') };
  const cases = [
    { folder: true, response: { f: [] } },
    { folder: true, response: {} },
    { folder: true, response: { f: [{ h: 'AAAAAAAA', k: 'AAAAAAAA:AA', a: 'AA', t: 1 }] } },
    { folder: false, response: { s: 4, at: 'AA' } },
    { folder: false, response: { s: 4 } },
    { folder: false, response: -9 },
    { folder: false, networkError: true },
  ];
  fs.writeFileSync(preload, `
const cases = ${JSON.stringify(cases)};
let calls = 0;
globalThis.fetch = async (input, init) => {
  const endpoint = new URL(String(input));
  const request = JSON.parse(String(init?.body))[0];
  if (endpoint.origin !== 'https://g.api.mega.co.nz' || endpoint.pathname !== '/cs' || request.g) {
    throw new Error('Unexpected network request; metadata must not download content');
  }
  const current = calls++;
  if (current % 2) return Response.json([${JSON.stringify(valid)}]);
  const fixture = cases[current / 2];
  if (fixture.networkError) throw new TypeError('Synthetic connection failure');
  return Response.json([fixture.response]);
};
`);
  const server = await startTestServer(directory, true, {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href} --unhandled-rejections=strict`,
    AOI_PROXY_URL: '', AOI_SNAPSHOT_ENABLED: 'false', AOI_REPLICA_SOURCE_URL: undefined,
  });
  try {
    const metadata = (folder: boolean) => fetch(`${server.url}/api/packs/mega-metadata`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `https://mega.nz/${folder ? 'folder' : 'file'}/AAAAAAAA#${(folder ? key.subarray(0, 16) : key).toString('base64url')}` }),
      signal: AbortSignal.timeout(3_000),
    });
    for (const fixture of cases) {
      const failed = await metadata(fixture.folder);
      assert.equal(failed.status, 400);
      assert.equal(typeof ((await failed.json()) as { error: string }).error, 'string');
      assert.equal(server.child.exitCode, null, server.output());
      assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
      const next = await metadata(false);
      assert.equal(next.status, 200, server.output());
      assert.deepEqual(await next.json(), { title: 'fixture', filename: 'fixture.zip', kind: 'archive', totalBytes: 4 });
    }
    assert.doesNotMatch(server.output(), /Uncaught exception|Unhandled rejection/);
  } finally {
    await stopTestServer(server, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
