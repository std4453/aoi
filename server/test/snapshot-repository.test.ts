import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-snapshot-db-'));
process.env.DATA_DIR = directory;
delete process.env.AOI_REPLICA_SOURCE_URL;
const { initDb, closeDb, getDb } = await import('../src/db/connection.js');
const { createPack, updatePackStatus, updatePackStats, renamePack, createTag, setPackTags, renameTag } = await import('../src/db/repositories.js');
const { contentRevision, writeState, readManifestCache } = await import('../src/db/snapshot-repository.js');
const { SnapshotPublisher } = await import('../src/replication/snapshots.js');

test('snapshot change tracking excludes local data and bookkeeping, but fences content and tag edits', async t => {
  await initDb();
  try {
    const db = getDb();
    const pack = createPack({ name: 'Content', originalFilename: 'folder', originalSize: 3, originalFormat: 'folder', sourceType: 'folder' });
    updatePackStatus(pack.id, 'extracted');
    updatePackStats(pack.id, { imageCount: 0, videoCount: 1, totalImagesSize: 0, totalVideosSize: 3 });
    const videos = path.join(directory, 'extracted', pack.id, 'videos');
    fs.mkdirSync(videos, { recursive: true }); fs.writeFileSync(path.join(videos, 'a.mp4'), 'abc');
    db.exec('CREATE TABLE viewing_history (value TEXT)');
    const publisher = new SnapshotPublisher(); publisher.initialize();
    const revision = contentRevision();
    const lstat = fs.promises.lstat;
    let injected = false;
    const spy = t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof lstat>) => {
      if (!injected) {
        injected = true;
        db.exec("INSERT INTO viewing_history VALUES ('private')");
        writeState('unrelated', 'state');
      }
      return lstat(...args);
    });
    await publisher.run(new AbortController().signal);
    assert.equal(contentRevision(), revision, 'history and manifest writes must not invalidate the candidate');
    assert.equal(publisher.entry(pack.id)?.state, 'ready');
    const calls = spy.mock.callCount();
    db.exec("INSERT INTO viewing_history VALUES ('more')"); writeState('unrelated', 'next');
    await publisher.run(new AbortController().signal);
    assert.equal(spy.mock.callCount(), calls, 'unrelated writes must not trigger another scan');
    spy.mock.restore();
    const first = readManifestCache(pack.id)!.manifest;
    renamePack(pack.id, 'Before hash');
    let changed = false;
    const mutation = t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof lstat>) => {
      if (!changed) { changed = true; renamePack(pack.id, 'During hash'); }
      return lstat(...args);
    });
    await assert.rejects(publisher.run(new AbortController().signal), /database changed/);
    assert.equal(publisher.entry(pack.id)?.state, 'pending');
    mutation.mock.restore();
    await publisher.run(new AbortController().signal);
    const next = readManifestCache(pack.id)!.manifest;
    assert.equal(next.metadata.name, 'During hash');
    assert.equal(next.contentHash, first.contentHash);
    const tag = createTag('Before'); setPackTags(pack.id, [tag.id]);
    await publisher.run(new AbortController().signal);
    const beforeTag = contentRevision(); renameTag(tag.id, 'After');
    assert.ok(contentRevision() > beforeTag);
    assert.equal(publisher.entry(pack.id)?.state, 'pending');
    await publisher.run(new AbortController().signal);
    assert.equal(readManifestCache(pack.id)!.manifest.metadata.tags[0].name, 'After');
  } finally { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); }
});
