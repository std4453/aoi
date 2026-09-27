import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-extraction-test-'));
process.env.DATA_DIR = path.join(root, 'data');
const { initDb, closeDb } = await import('../src/db/connection.js');
await initDb();
const repo = await import('../src/db/repositories.js');
const { archiveExtractor } = await import('../src/services/archive-extractor.js');
const { jobQueue } = await import('../src/services/job-queue.js');
const { registerPackRoutes } = await import('../src/routes/packs.js');
const { default: Fastify } = await import('fastify');
const { default: sharp } = await import('sharp');
const app = Fastify();
await app.register(registerPackRoutes);
await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
  .png().toFile(path.join(root, 'image.png'));

function pack(encrypted: boolean) {
  const result = repo.createPack({ name: 'test', originalFilename: 'test.zip', originalSize: 1, originalFormat: 'zip' });
  const archiveDir = path.join(process.env.DATA_DIR!, 'archives', result.id);
  fs.mkdirSync(archiveDir, { recursive: true });
  execFileSync('zip', ['-q', ...(encrypted ? ['-P', 'secret'] : []), path.join(archiveDir, 'original.zip'), 'image.png'], { cwd: root });
  return result;
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'queue should finish within 5 seconds');
    await delay(25);
  }
}

after(async () => {
  await app.close();
  await jobQueue.shutdown(5000);
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test('encrypted ZIP without password fails clearly and cleans temporary extraction', async () => {
  const encrypted = pack(true);
  await assert.rejects(archiveExtractor.extract(encrypted), /需要密码/);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR!, 'extracted', encrypted.id, '_temp_extract')), false);
});

test('failed encrypted ZIP releases queue, permits deletion, and next ZIP finishes', async () => {
  const encrypted = pack(true);
  const normal = pack(false);
  const failedJob = await jobQueue.enqueue(encrypted.id, 'extract');
  await jobQueue.enqueue(normal.id, 'extract');
  await waitFor(() => repo.getPack(normal.id)?.status === 'extracted');
  assert.equal(repo.getJob(failedJob.id)?.status, 'failed');
  assert.match(repo.getPack(encrypted.id)!.errorMessage!, /需要密码/);
  assert.equal(repo.getPack(normal.id)?.imageCount, 1);
  const response = await app.inject({ method: 'DELETE', url: `/api/packs/${encrypted.id}` });
  assert.equal(response.statusCode, 200);
  assert.equal(repo.getPack(encrypted.id), undefined);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR!, 'archives', encrypted.id)), false);
});

test('startup retries interrupted extraction and drains pending ZIP uploads', async () => {
  const interrupted = pack(true);
  const normal = pack(false);
  const oldJob = repo.createJob(interrupted.id, 'extract');
  repo.updateJobStatus(oldJob.id, 'running');
  repo.updatePackStatus(interrupted.id, 'extracting');
  repo.createJob(normal.id, 'extract');
  repo.recoverInterruptedJobs();
  jobQueue.start();
  await waitFor(() => repo.getPack(normal.id)?.status === 'extracted');
  assert.equal(repo.getJob(oldJob.id)?.status, 'failed');
  assert.equal(repo.getPack(interrupted.id)?.status, 'failed');
});

test('ZIP fallback closes stdin so a password prompt cannot block the queue', async () => {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // Emulate an extractor waiting for password input; EOF must end the process.
  fs.writeFileSync(path.join(bin, '7z'), `#!${process.execPath}\nif (process.argv[2] === 'i') process.exit(0);\nif (process.argv[2] === 'l' && process.env.AOI_TEST_LIST_SUCCESS) process.exit(0);\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { console.error('Enter password: Wrong password'); process.exit(2); });\n`);
  fs.chmodSync(path.join(bin, '7z'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const broken = pack(false);
    fs.writeFileSync(path.join(process.env.DATA_DIR!, 'archives', broken.id, 'original.zip'), 'invalid ZIP');
    const normal = pack(false);
    await jobQueue.enqueue(broken.id, 'extract');
    await jobQueue.enqueue(normal.id, 'extract');
    await waitFor(() => repo.getPack(normal.id)?.status === 'extracted');
    assert.match(repo.getPack(broken.id)!.errorMessage!, /需要密码/);
    await assert.rejects(archiveExtractor.extract(broken, 'wrong'), /密码错误/);
    // Also exercise the extraction prompt after a successful archive listing.
    process.env.AOI_TEST_LIST_SUCCESS = '1';
    await assert.rejects(archiveExtractor.extract(broken), /需要密码/);
    await assert.rejects(archiveExtractor.extract(broken, 'wrong'), /密码错误/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.AOI_TEST_LIST_SUCCESS;
  }
});
