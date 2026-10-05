import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import migration from '~/db/migrations/008_add_content_verification';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-verification-'));
process.env.DATA_DIR = dataDir;
const db = await import('~/db/connection');
const repo = await import('~/db/repositories');
const verification = await import('~/services/content-verification');
const storage = await import('~/services/storage');
await db.initDb();
test.after(() => { db.closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });
test.afterEach(() => { for (const pack of repo.listPacks()) repo.deletePack(pack.id); });

function pack(sourceType: 'archive' | 'folder', entries: Array<[string, string]>) {
  const created = repo.createPack({ name: sourceType, originalFilename: 'test', originalSize: 1, originalFormat: sourceType === 'archive' ? 'zip' : 'folder', sourceType });
  fs.mkdirSync(storage.getExtractedImagesDir(created.id), { recursive: true });
  for (const [name, content] of entries) {
    const destination = path.join(storage.getExtractedImagesDir(created.id), name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  repo.updatePackStats(created.id, { imageCount: entries.length, videoCount: 0, totalImagesSize: entries.reduce((sum, [, value]) => sum + Buffer.byteLength(value), 0), totalVideosSize: 0 });
  return created.id;
}
async function verify(id: string) {
  verification.scheduleVerification(id);
  await verification.verifyPack(id, new AbortController().signal, () => {});
}

test('content fingerprint ignores names and paths but preserves contents, sizes and multiplicity', async () => {
  const first = pack('archive', [['a.png', 'one'], ['sub/b.png', 'two'], ['zero.png', '']]);
  const renamed = pack('folder', [['x/y.png', 'two'], ['z.png', 'one'], ['empty.png', '']]);
  const extraCopy = pack('folder', [['a.png', 'one'], ['b.png', 'two'], ['c.png', 'one'], ['empty.png', '']]);
  const changed = pack('folder', [['a.png', 'ONE'], ['b.png', 'two'], ['empty.png', '']]);
  fs.mkdirSync(storage.getThumbnailsDir(first), { recursive: true });
  fs.writeFileSync(path.join(storage.getThumbnailsDir(first), 'ignored.jpg'), 'not included');
  fs.writeFileSync(path.join(storage.getPath('extracted', first), 'ignored.txt'), 'not included');
  const fingerprint = (await verification.computeContentFingerprint(first)).fingerprint;
  assert.equal((await verification.computeContentFingerprint(renamed)).fingerprint, fingerprint);
  assert.notEqual((await verification.computeContentFingerprint(extraCopy)).fingerprint, fingerprint);
  assert.notEqual((await verification.computeContentFingerprint(changed)).fingerprint, fingerprint);
});

test('verification snapshots are immutable, archives never await approval, folder confirmation is idempotent', async () => {
  const original = pack('archive', [['a.png', 'same']]);
  await verify(original);
  const archivedAgain = pack('archive', [['b.png', 'same']]);
  await verify(archivedAgain);
  assert.equal(repo.getPack(archivedAgain)?.status, 'thumbnailing');
  assert.equal(JSON.parse(verification.getVerification(archivedAgain)!.matches!).length, 1);
  const folder = pack('folder', [['renamed.png', 'same']]);
  await verify(folder);
  assert.equal(repo.getPack(folder)?.status, 'awaiting_confirmation');
  assert.equal(repo.getLatestJob(folder, 'thumbnail'), undefined);
  const snapshot = verification.getVerification(folder)!;
  assert.equal(JSON.parse(snapshot.matches!).length, 2);
  const waitingFolder = pack('folder', [['another.png', 'same']]);
  await verify(waitingFolder);
  assert.equal(JSON.parse(verification.getVerification(waitingFolder)!.matches!).length, 2);
  repo.renamePack(original, 'renamed original');
  repo.deletePack(archivedAgain);
  assert.deepEqual(verification.getLiveMatches(folder).map(p => p.name), ['renamed original']);
  assert.equal(verification.getVerification(folder)!.matches, snapshot.matches);
  verification.continueFolderVerification(folder);
  verification.continueFolderVerification(folder);
  assert.equal(repo.getPack(folder)?.status, 'thumbnailing');
  assert.equal((db.getDb().prepare("SELECT count(*) AS n FROM jobs WHERE pack_id = ? AND type = 'thumbnail'").get(folder) as { n: number }).n, 1);
  repo.updatePackStatus(folder, 'extracted');
  await verification.verifyPack(folder, new AbortController().signal, () => {});
  assert.equal(repo.getPack(folder)?.status, 'extracted');
  assert.equal(verification.getVerification(folder)!.checked_at, snapshot.checked_at);
  assert.equal(verification.getVerification(folder)!.matches, snapshot.matches);
  assert.equal('matches' in repo.toPublicPack(repo.getPack(folder)!), false);
});

test('empty packs never match; incomplete data and symlinks fail without publishing a fingerprint', async () => {
  const empty = pack('archive', []);
  const emptyFolder = pack('folder', []);
  await verify(empty);
  await verify(emptyFolder);
  assert.equal(verification.getVerification(emptyFolder)?.matches, '[]');
  assert.equal(repo.getPack(emptyFolder)?.status, 'thumbnailing');
  const broken = pack('folder', [['one.png', 'one']]);
  fs.unlinkSync(path.join(storage.getExtractedImagesDir(broken), 'one.png'));
  await assert.rejects(verify(broken), /不完整/);
  assert.equal(verification.getVerification(broken)?.fingerprint, null);
  const unsafe = pack('folder', []);
  fs.symlinkSync('/etc/hosts', path.join(storage.getExtractedImagesDir(unsafe), 'link.png'));
  await assert.rejects(verification.computeContentFingerprint(unsafe), /符号链接/);
});

test('migration queues historical work once, keeps preview available and restores prior state', async () => {
  const historic = pack('archive', [['one.png', 'one']]);
  repo.updatePackStatus(historic, 'generated');
  const ongoing = pack('archive', [['one.png', 'one']]);
  repo.updatePackStatus(ongoing, 'generating');
  const compression = repo.createJob(ongoing, 'compress');
  migration.up(db.getDb());
  migration.up(db.getDb());
  assert.equal(repo.getPack(historic)?.status, 'verifying');
  assert.equal(repo.toPublicPack(repo.getPack(historic)!).verification?.allowsPreview, true);
  assert.equal(repo.getPack(ongoing)?.status, 'generating');
  assert.equal((db.getDb().prepare("SELECT count(*) AS n FROM jobs WHERE type = 'verify'").get() as { n: number }).n, 2);
  assert.equal(repo.claimNextPendingJob()?.id, compression.id);
  await verification.verifyPack(historic, new AbortController().signal, () => {});
  assert.equal(repo.getPack(historic)?.status, 'generated');
  const snapshot = verification.getVerification(historic)!.matches;
  const newFolder = pack('folder', [['renamed.png', 'one']]);
  await verify(newFolder);
  assert.equal(repo.getPack(newFolder)?.status, 'awaiting_confirmation');
  assert.equal(verification.getVerification(historic)!.matches, snapshot);
  verification.failVerification(ongoing, 'missing data');
  assert.equal(repo.getPack(ongoing)?.status, 'generated');
  assert.equal(verification.getVerification(ongoing)?.status, 'failed');
});

test('cancelled hashing does not publish a partial result', async () => {
  const id = pack('folder', [['large.png', 'x'.repeat(200_000)]]);
  verification.scheduleVerification(id);
  const controller = new AbortController();
  await assert.rejects(verification.verifyPack(id, controller.signal, () => controller.abort()), { name: 'AbortError' });
  assert.equal(verification.getVerification(id)?.fingerprint, null);
  assert.equal(verification.getVerification(id)?.checked_at, null);
});

test('queue cancellation waits for verification streams to close and leaves no follow-up job', async () => {
  const { jobQueue } = await import('~/services/job-queue');
  const id = pack('folder', [['large.png', 'x'.repeat(1_000_000)]]);
  verification.scheduleVerification(id);
  let cancellation: Promise<void> | undefined;
  const onProgress = (progress: { phase: string }) => {
    if (progress.phase === 'verifying' && !cancellation) cancellation = jobQueue.cancelVerification(id);
  };
  jobQueue.on('progress', onProgress);
  jobQueue.start();
  try {
    for (let i = 0; i < 100 && !cancellation; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(cancellation);
    await cancellation;
    assert.equal(repo.getLatestJob(id, 'verify')?.status, 'cancelled');
    assert.equal(repo.getLatestJob(id, 'thumbnail'), undefined);
    assert.equal(verification.getVerification(id)?.fingerprint, null);
    storage.removePackFiles(id);
    repo.deletePack(id);
    assert.equal(repo.getPack(id), undefined);
  } finally {
    jobQueue.off('progress', onProgress);
    await jobQueue.shutdown(5000);
  }
});
