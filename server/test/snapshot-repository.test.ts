import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import migration from '~/db/migrations/009_add_snapshots';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-snapshot-db-'));
process.env.DATA_DIR = directory;
delete process.env.AOI_REPLICA_SOURCE_URL;
const { initDb, closeDb, getDb } = await import('~/db/connection');
const { createPack, updatePackStatus, updatePackStats, renamePack, createTag, setPackTags, renameTag } = await import('~/db/repositories');
const { contentRevision, writeState, readManifestCache } = await import('~/db/snapshot-repository');
const { SnapshotPublisher } = await import('~/replication/snapshots');

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

test('the single snapshot migration upgrades existing data and is idempotent', () => {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
    db.exec("ALTER TABLE packs ADD COLUMN source_type TEXT DEFAULT 'archive'; INSERT INTO packs(id,name,original_filename,original_size,original_format) VALUES ('existing','Original','original.zip',7,'zip');");
    migration.up(db);
    db.prepare("UPDATE snapshot_content_clock SET revision=42").run();
    migration.up(db);
    assert.equal(db.prepare('SELECT name FROM packs').pluck().get(), 'Original');
    assert.equal(db.prepare('SELECT revision FROM snapshot_content_clock').pluck().get(), 42);
    assert.deepEqual((db.pragma('table_info(replica_packs)') as { name: string }[]).map(column => column.name), ['pack_id', 'manifest']);
    db.exec("INSERT INTO tags(id,name) VALUES ('tag','Tag'); INSERT INTO pack_tags VALUES ('existing','tag');");
    assert.equal(db.prepare('SELECT name FROM pack_display_tags').pluck().get(), 'Tag');
  } finally { db.close(); }
});
