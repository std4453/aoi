import assert from 'node:assert/strict';
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { encrypt, type File as MegaFile } from '@std4453/megajs';
import { MegaPasswordError, resolveMegaUrl, validateMegaUrl } from '~/services/mega-link';
import { describeMegaShare, downloadMegaShare, megaShareTitle, planMegaFiles } from '~/services/mega-download';

const handle = 'GRBSjBCI';
const key = 'W-PD47BgVmkIB9x_c5DFPilhYrtwk21hdwyppp-1pO8';

test('MEGA links allow public shares only and normalize modern, legacy and split keys', async () => {
  assert.equal(await resolveMegaUrl(`https://mega.nz/file/${handle}#${key}`), `https://mega.nz/file/${handle}#${key}`);
  assert.equal(await resolveMegaUrl(`https://mega.co.nz/#!${handle}!${key}`), `https://mega.nz/file/${handle}#${key}`);
  assert.equal(await resolveMegaUrl(`https://mega.nz/file/${handle}`, key), `https://mega.nz/file/${handle}#${key}`);
  assert.equal(await resolveMegaUrl(`https://mega.nz/file/${handle}#${Buffer.alloc(32).toString('base64url')}`, key), `https://mega.nz/file/${handle}#${key}`);
  const folderKey = Buffer.alloc(16, 1).toString('base64url');
  assert.equal(await resolveMegaUrl(`https://mega.nz/folder/${handle}#${folderKey}/folder/ABCDEFGH`), `https://mega.nz/folder/${handle}#${folderKey}/file/ABCDEFGH`);
  await assert.rejects(resolveMegaUrl(`https://mega.nz/file/${handle}`), MegaPasswordError);
  for (const url of ['https://evil.test/file/GRBSjBCI#x', 'https://mega.nz.evil.test/file/GRBSjBCI#x',
    'http://mega.nz/file/GRBSjBCI#x', 'https://user@mega.nz/file/GRBSjBCI#x', 'https://mega.nz:444/file/GRBSjBCI#x',
    'https://mega.nz/fm/GRBSjBCI#x', 'https://mega.nz/file/GRBSjBCI?redirect=evil#x']) {
    assert.throws(() => validateMegaUrl(url));
  }
});

// Encode fixtures using MEGA's documented wire format, including legacy reversed HMAC arguments.
function protectedLink(algorithm: number, folder: boolean): { url: string; expected: string } {
  const salt = Buffer.alloc(32, 0xa5);
  const rawKey = Buffer.alloc(folder ? 16 : 32, 0x7f);
  const derived = pbkdf2Sync('测试 password', salt, algorithm === 0 ? 1_000 : 100_000, 64, 'sha512');
  const encrypted = rawKey.map((byte, i) => byte ^ derived[i]);
  const body = Buffer.concat([Buffer.from([algorithm, folder ? 0 : 1]), Buffer.from(handle, 'base64url'), salt, encrypted]);
  const mac = algorithm === 1 ? createHmac('sha256', body).update(derived.subarray(32)).digest()
    : createHmac('sha256', derived.subarray(32)).update(body).digest();
  return { url: `https://mega.nz/#P!${Buffer.concat([body, mac]).toString('base64url')}`,
    expected: `https://mega.nz/${folder ? 'folder' : 'file'}/${handle}#${rawKey.toString('base64url')}` };
}

test('MEGA password protected files and folders support current and legacy formats', async () => {
  for (const algorithm of [0, 1, 2]) for (const folder of [false, true]) {
    const fixture = protectedLink(algorithm, folder);
    assert.equal(await resolveMegaUrl(fixture.url, ' 测试 password '), fixture.expected);
    await assert.rejects(resolveMegaUrl(fixture.url, 'incorrect'), MegaPasswordError);
    await assert.rejects(resolveMegaUrl(fixture.url), MegaPasswordError);
    const payload = Buffer.from(new URL(fixture.url).hash.slice(3), 'base64url');
    payload[10] ^= 1;
    await assert.rejects(resolveMegaUrl(`https://mega.nz/#P!${payload.toString('base64url')}`, '测试 password'), MegaPasswordError);
  }
});

function file(name: string, size = 4): MegaFile {
  return { name, size, directory: false } as MegaFile;
}

function folder(name: string, children: MegaFile[]): MegaFile {
  return { name, directory: true, children } as MegaFile;
}

test('MEGA folder planning preserves relative paths and rejects unsafe remote metadata', () => {
  const tree = folder('photos', [folder('day 1', [file('a.jpg')]), file('b.png')]);
  assert.deepEqual(planMegaFiles(tree).map(({ relativePath, fileSize }) => ({ relativePath, fileSize })), [
    { relativePath: 'day 1/a.jpg', fileSize: 4 }, { relativePath: 'b.png', fileSize: 4 },
  ]);
  for (const name of ['../escape.jpg', 'C:\\image.jpg', 'stream.jpg:secret', 'NUL.jpg', 'nested/a.jpg', 'trailing.']) {
    assert.throws(() => planMegaFiles(folder('photos', [file(name)])));
  }
  assert.throws(() => planMegaFiles(folder('photos', [file('a.jpg'), file('A.jpg')])));
  assert.throws(() => planMegaFiles(folder('photos', [file('a.jpg', -1)])));
  assert.throws(() => planMegaFiles(folder('photos', [file('a.jpg', Number.MAX_SAFE_INTEGER)])));
  assert.throws(() => planMegaFiles(file('a.txt')));
  assert.throws(() => planMegaFiles(folder('empty', [])));
  const cycle = folder('cycle', []);
  cycle.children!.push(cycle);
  assert.throws(() => planMegaFiles(cycle));
  assert.equal(planMegaFiles(file('photos.7z'))[0].relativePath, 'photos.7z');
});

async function encryptedFixture() {
  const plaintext = Buffer.alloc(400_000, 0x42);
  const encryption = encrypt(Buffer.alloc(24, 0x13)) as unknown as NodeJS.ReadWriteStream & { key: Buffer };
  const chunks: Buffer[] = [];
  const finished = new Promise<void>((resolve, reject) => {
    encryption.on('data', chunk => chunks.push(chunk));
    encryption.on('end', resolve);
    encryption.on('error', reject);
  });
  encryption.end(Buffer.from(plaintext));
  await finished;
  return { plaintext, ciphertext: Buffer.concat(chunks), key: encryption.key };
}

function attributes(name: string, key: Buffer): string {
  const aesKey = Buffer.from(key.subarray(0, 16));
  if (key.length === 32) for (let i = 0; i < 16; i++) aesKey[i] ^= key[i + 16];
  const text = Buffer.from(`MEGA${JSON.stringify({ n: name })}`);
  const padded = Buffer.alloc(Math.ceil(text.length / 16) * 16);
  text.copy(padded);
  const cipher = createCipheriv('aes-128-cbc', aesKey, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64url');
}

test('MEGA metadata resolves a title without downloading data or inventing public author tags', async () => {
  const fixture = await encryptedFixture();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/cs');
    const request = JSON.parse(String(init?.body))[0];
    assert.equal(request.a, 'g');
    assert.equal(request.g, undefined, 'metadata must not request the download URL');
    requests++;
    return Response.json([{ s: fixture.plaintext.length, at: attributes('Photos.ZIP', fixture.key), u: 'opaque-user-handle' }]);
  };
  try {
    const metadata = await describeMegaShare({ url: `https://mega.nz/file/${handle}#${fixture.key.toString('base64url')}` });
    assert.deepEqual(metadata, { title: 'Photos', filename: 'Photos.ZIP', kind: 'archive', totalBytes: fixture.plaintext.length });
    assert.equal(requests, 1);
    assert.equal(megaShareTitle('Folder.zip', 'folder'), 'Folder.zip');
    assert.equal(megaShareTitle('.zip', 'archive'), '.zip');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MEGA downloader verifies full content, reuses finished files and rejects corrupted transfers', async () => {
  const fixture = await encryptedFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-mega-download-'));
  const originalFetch = globalThis.fetch;
  let dataRequests = 0;
  let corrupt = false;
  let storageUrl = 'https://storage.mega.co.nz/content';
  let oversized = false;
  globalThis.fetch = async (input, init) => {
    const endpoint = new URL(String(input));
    if (endpoint.pathname === '/cs') {
      const request = JSON.parse(String(init?.body))[0];
      return Response.json([{ s: fixture.plaintext.length, at: attributes('photos.zip', fixture.key),
        ...(request.g ? { g: storageUrl } : {}),
      }], oversized ? { headers: { 'content-length': String(65 * 1024 * 1024) } } : undefined);
    }
    dataRequests++;
    const [start, end] = endpoint.pathname.split('/').pop()!.split('-').map(Number);
    const bytes = Buffer.from(fixture.ciphertext.subarray(start, end + 1));
    if (corrupt && start === 0) bytes[0] ^= 1;
    return new Response(bytes);
  };
  try {
    const options = { url: `https://mega.nz/file/${handle}#${fixture.key.toString('base64url')}`, destination: directory };
    const progress: number[] = [];
    const result = await downloadMegaShare({ ...options, onProgress: value => progress.push(value.transferredBytes) });
    assert.equal(result.kind, 'archive');
    assert.deepEqual(fs.readFileSync(result.contentPath), fixture.plaintext);
    assert.equal(progress.at(-1), fixture.plaintext.length);
    const requests = dataRequests;
    await downloadMegaShare(options);
    assert.equal(dataRequests, requests, 'verified complete files should be reused on restart');
    corrupt = true;
    await assert.rejects(downloadMegaShare({ ...options, destination: path.join(directory, 'corrupt') }), /MAC verification failed/);
    assert.equal(fs.existsSync(path.join(directory, 'corrupt', 'contents', 'photos.zip')), false);
    corrupt = false;
    storageUrl = 'https://127.0.0.1/private';
    await assert.rejects(downloadMegaShare({ ...options, destination: path.join(directory, 'untrusted') }), /不受信任/);
    storageUrl = 'https://storage.mega.co.nz/content';
    oversized = true;
    await assert.rejects(downloadMegaShare({ ...options, destination: path.join(directory, 'oversized') }), /资源限制/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MEGA downloader handles nested folder selections using the task API and supports cancellation', async () => {
  const fixture = await encryptedFixture();
  const rootKey = Buffer.alloc(16, 0x21);
  const wrap = (key: Buffer) => {
    const cipher = createCipheriv('aes-128-ecb', rootKey, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(key), cipher.final()]).toString('base64url');
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-mega-folder-'));
  const originalFetch = globalThis.fetch;
  let hanging = false;
  globalThis.fetch = async (input, init) => {
    if (hanging) return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
    const endpoint = new URL(String(input));
    if (endpoint.pathname === '/cs') {
      const request = JSON.parse(String(init?.body))[0];
      if (request.a === 'f') return Response.json([{ f: [
        { h: 'ROOTROOT', t: 1, k: `ROOTROOT:${wrap(rootKey)}`, a: attributes('Photos', rootKey) },
        { h: 'SUBFOLDR', p: 'ROOTROOT', t: 1, k: `ROOTROOT:${wrap(rootKey)}`, a: attributes('Selected', rootKey) },
        { h: 'FILEFILE', p: 'SUBFOLDR', t: 0, s: fixture.plaintext.length, k: `ROOTROOT:${wrap(fixture.key)}`, a: attributes('image.png', fixture.key) },
      ] }]);
      assert.equal(request.n, 'FILEFILE');
      assert.equal(endpoint.searchParams.get('n'), handle);
      return Response.json([{ s: fixture.plaintext.length, g: 'https://storage.mega.co.nz/content' }]);
    }
    const [start, end] = endpoint.pathname.split('/').pop()!.split('-').map(Number);
    return new Response(fixture.ciphertext.subarray(start, end + 1));
  };
  try {
    const url = `https://mega.nz/folder/${handle}#${rootKey.toString('base64url')}/folder/SUBFOLDR`;
    assert.deepEqual(await describeMegaShare({ url }), { title: 'Selected', filename: 'Selected', kind: 'folder', totalBytes: fixture.plaintext.length });
    const result = await downloadMegaShare({ url, destination: directory });
    assert.equal(result.kind, 'folder');
    assert.equal(result.name, 'Selected');
    assert.deepEqual(result.files, [{ relativePath: 'image.png', fileSize: fixture.plaintext.length }]);
    assert.deepEqual(fs.readFileSync(path.join(result.contentPath, 'image.png')), fixture.plaintext);
    hanging = true;
    const controller = new AbortController();
    const pending = downloadMegaShare({ url, destination: path.join(directory, 'cancelled'), signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
