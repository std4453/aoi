import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, digest, makeManifest, manifestPack, validateIndex, validateManifest, contractValues, safeContentFile } from '../src/replication/protocol.js';
import { beginMutation, snapshotFence, assertSnapshotFence, activateVersion, clearVersions, pinVersion, referencedRoots, readContext } from '../src/replication/state.js';
import type { StoredPack } from '../src/db/repositories.js';

const pack: StoredPack = { id: 'pack1', name: 'Pack', originalFilename: 'archive.zip', originalSize: 9,
  originalFormat: 'zip', sourceType: 'archive', status: 'generated', imageCount: 1, videoCount: 0,
  totalImagesSize: 9, totalVideosSize: 0, errorMessage: null, archivePassword: 'secret', compressedSize: 5,
  tags: [{ id: 'tag1', name: 'Tag' }], createdAt: '2026-10-01', updatedAt: '2026-10-01' };
const file = { path: 'images/nested/a.jpg', hash: 'a'.repeat(64), size: 9 };

test('snapshot contract excludes private and derived data; metadata changes do not change file identity', () => {
  const first = makeManifest(pack, [file]);
  const renamed = makeManifest({ ...pack, name: 'Renamed', compressedSize: 999 }, [file]);
  assert.equal(first.protocol, '1.0.0');
  assert.equal(first.contentHash, renamed.contentHash);
  assert.notEqual(first.revision, renamed.revision);
  assert.equal(canonicalJson(first).includes('secret'), false);
  assert.equal('status' in first.metadata, false);
  assert.equal('compressedSize' in first.metadata, false);
  assert.equal(manifestPack(first).status, 'extracted');
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.deepEqual(validateManifest(first), first);
});

test('reject mismatched patch, paths, duplicate identities and tampered manifests', () => {
  const first = makeManifest(pack, [file]);
  for (const protocol of ['1.0.1', '1.1.0', '2.0.0', 1, undefined]) assert.throws(() => validateManifest({ ...first, protocol }), /protocol mismatch/);
  assert.throws(() => validateManifest({ ...first, metadata: { ...first.metadata, name: 'tampered' } }), /checksum/);
  for (const name of ['images/../escape', 'images/a\\b.jpg', 'thumbnails/a.jpg', '/images/a.jpg']) {
    assert.throws(() => makeManifest(pack, [{ ...file, path: name }]));
  }
  assert.throws(() => makeManifest(pack, [file, file]), /Duplicate/);
  assert.throws(() => makeManifest(pack, [{ ...file, path: 'images/a' }, { ...file, path: 'images/a/b' }]), /Conflicting/);
  assert.throws(() => validateIndex({ ...contractValues(), datasetId: 'ee272abc-7746-416a-9bda-90a03734653c', packs: [{ id: 'pack1', state: 'pending' }, { id: 'pack1', state: 'pending' }] }), /Duplicate/);
});

test('mutation fences reject overlapping writers; old per-pack roots remain pinned across activation', () => {
  const fence = snapshotFence(); const end = beginMutation();
  assert.throws(() => snapshotFence(), /deferred/); end(); end();
  assert.throws(() => assertSnapshotFence(fence), /changed/);
  const old = { id: 'old', root: '/old', pack, readers: 0 };
  activateVersion(old); const release = pinVersion(old);
  readContext.run(old, () => {
    activateVersion({ ...old, id: 'new', root: '/new', readers: 0 });
    assert.equal(readContext.getStore()?.root, '/old');
    assert.deepEqual([...referencedRoots()].sort(), ['/new', '/old']);
  });
  release(); release(); assert.deepEqual([...referencedRoots()], ['/new']); clearVersions();
});


test('content reads reject symlinks in both files and parent directories', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-snapshot-path-'));
  try {
    const root = path.join(directory, 'content');
    fs.mkdirSync(path.join(root, 'images'), { recursive: true });
    fs.writeFileSync(path.join(root, 'images', 'real.jpg'), 'content');
    fs.writeFileSync(path.join(directory, 'private'), 'secret');
    assert.equal(await safeContentFile(root, 'images/real.jpg'), path.join(root, 'images/real.jpg'));
    fs.symlinkSync(path.join(directory, 'private'), path.join(root, 'images', 'link.jpg'));
    await assert.rejects(safeContentFile(root, 'images/link.jpg'), /Invalid content/);
    fs.symlinkSync(directory, path.join(root, 'videos'));
    await assert.rejects(safeContentFile(root, 'videos/private'), /Invalid content/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
