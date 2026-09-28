import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { createJobIfIdle, getPack, updatePackStatus } from '../db/repositories.js';
import { getExtractedImagesDir, getExtractedVideosDir } from './storage.js';
import { resolveWithin } from './safe-path.js';
import type { DuplicatePack, PackStatus } from '../../../shared/types.js';

export const FINGERPRINT_VERSION = 'media-md5-v1';

export interface VerificationRecord {
  pack_id: string;
  version: string;
  status: 'pending' | 'completed' | 'failed';
  fingerprint: string | null;
  file_count: number | null;
  total_bytes: number | null;
  checked_at: string | null;
  matches: string | null;
  error: string | null;
  historical: number;
  next_status: PackStatus;
  previous_error: string | null;
  approved: number;
}

export function getVerification(packId: string): VerificationRecord | undefined {
  return getDb().prepare('SELECT * FROM pack_verifications WHERE pack_id = ?').get(packId) as VerificationRecord | undefined;
}

// A snapshot is immutable. Only the actionable list resolves current names and deletions.
export function getLiveMatches(packId: string): DuplicatePack[] {
  const snapshot = JSON.parse(getVerification(packId)?.matches ?? '[]') as Array<{ id: string; name: string }>;
  return snapshot.flatMap(match => {
    const pack = getPack(match.id);
    return pack ? [{ id: pack.id, name: pack.name, status: pack.status }] : [];
  });
}

export function scheduleVerification(packId: string): void {
  getDb().transaction(() => {
    const pack = getPack(packId);
    if (!pack) throw new Error('Pack not found');
    getDb().prepare(`INSERT OR IGNORE INTO pack_verifications (pack_id, approved)
      VALUES (?, ?)`).run(packId, pack.sourceType === 'archive' ? 1 : 0);
    getDb().prepare("UPDATE pack_verifications SET status = CASE WHEN status = 'completed' THEN status ELSE 'pending' END, error = NULL WHERE pack_id = ?").run(packId);
    updatePackStatus(packId, 'verifying');
    createJobIfIdle(packId, 'verify');
  })();
}

// Call after an existing foreground task finishes, before historical verification.
export function resumeHistoricalVerification(packId: string): void {
  const record = getVerification(packId);
  const pack = getPack(packId);
  if (!record?.historical || record.status !== 'pending' || !pack) return;
  getDb().transaction(() => {
    if (pack.status !== 'verifying') {
      getDb().prepare('UPDATE pack_verifications SET next_status = ?, previous_error = ? WHERE pack_id = ?')
        .run(pack.status, pack.errorMessage, packId);
    }
    updatePackStatus(packId, 'verifying');
    createJobIfIdle(packId, 'verify');
  })();
}

export function advanceAfterVerification(packId: string): void {
  const record = getVerification(packId);
  if (!record || record.status !== 'completed') return;
  if (!record.approved && getLiveMatches(packId).length > 0) {
    updatePackStatus(packId, 'awaiting_confirmation');
    return;
  }
  getDb().prepare('UPDATE pack_verifications SET approved = 1 WHERE pack_id = ?').run(packId);
  updatePackStatus(packId, record.next_status, record.previous_error ?? undefined);
  if (record.next_status === 'thumbnailing') createJobIfIdle(packId, 'thumbnail');
}

export function continueFolderVerification(packId: string): void {
  getDb().transaction(() => {
    const record = getVerification(packId);
    if (!record || record.status !== 'completed') throw new Error('Verification has not completed');
    // A retry after processing began must not reset its state or enqueue another task.
    if (record.approved) return;
    getDb().prepare('UPDATE pack_verifications SET approved = 1 WHERE pack_id = ?').run(packId);
    advanceAfterVerification(packId);
  })();
}

export function failVerification(packId: string, error: string): void {
  getDb().transaction(() => {
    const record = getVerification(packId);
    if (!record) return;
    getDb().prepare("UPDATE pack_verifications SET status = 'failed', error = ? WHERE pack_id = ? AND status != 'completed'").run(error, packId);
    if (record.historical) updatePackStatus(packId, record.next_status, record.previous_error ?? undefined);
    else updatePackStatus(packId, 'failed', `校验失败：${error}`);
  })();
}

async function collectFiles(root: string, signal?: AbortSignal): Promise<Array<{ path: string; size: number }>> {
  const files: Array<{ path: string; size: number }> = [];
  async function visit(directory: string): Promise<void> {
    signal?.throwIfAborted();
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const full = resolveWithin(directory, entry.name, 'verification path');
      if (entry.isSymbolicLink()) throw new Error('校验目录包含符号链接');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push({ path: full, size: (await fs.promises.stat(full)).size });
    }
  }
  if (fs.existsSync(root)) {
    if ((await fs.promises.lstat(root)).isSymbolicLink()) throw new Error('校验目录包含符号链接');
    await visit(root);
  }
  return files;
}

export async function computeContentFingerprint(
  packId: string,
  signal?: AbortSignal,
  onProgress: (completed: number, total: number) => void = () => {},
): Promise<{ fingerprint: string; fileCount: number; totalBytes: number }> {
  const images = getExtractedImagesDir(packId);
  const videos = getExtractedVideosDir(packId);
  if (!fs.existsSync(images) && !fs.existsSync(videos)) throw new Error('解压后的文件目录缺失');
  const files = [...await collectFiles(images, signal), ...await collectFiles(videos, signal)];
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  const entries: Array<[number, string]> = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const hash = createHash('md5');
    let bytes = 0;
    for await (const chunk of fs.createReadStream(file.path, { signal })) {
      hash.update(chunk);
      bytes += chunk.length;
      completed += chunk.length;
      onProgress(completed, totalBytes);
    }
    if (bytes !== file.size) throw new Error(`校验期间文件发生变化：${path.basename(file.path)}`);
    entries.push([bytes, hash.digest('hex')]);
  }
  entries.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const fingerprint = createHash('md5').update(JSON.stringify([FINGERPRINT_VERSION, entries])).digest('hex');
  signal?.throwIfAborted();
  onProgress(totalBytes, totalBytes);
  return { fingerprint, fileCount: files.length, totalBytes };
}

export async function verifyPack(packId: string, signal: AbortSignal, onProgress: (completed: number, total: number) => void): Promise<void> {
  const record = getVerification(packId);
  if (!record) throw new Error('Verification record missing');
  if (record.status !== 'completed') {
    const result = await computeContentFingerprint(packId, signal, onProgress);
    const pack = getPack(packId);
    if (!pack || result.fileCount !== pack.imageCount + pack.videoCount || result.totalBytes !== pack.totalImagesSize + pack.totalVideosSize) {
      throw new Error('解压后的文件不完整或大小与记录不一致');
    }
    signal.throwIfAborted();
    // Fingerprint publication, duplicate lookup and the next stage are atomic.
    getDb().transaction(() => {
      const matches = result.fileCount === 0 ? [] : getDb().prepare(`SELECT p.id, p.name FROM pack_verifications v
        JOIN packs p ON p.id = v.pack_id WHERE v.status = 'completed' AND v.approved = 1
        AND v.version = ? AND v.fingerprint = ? AND v.pack_id != ? ORDER BY p.created_at DESC, p.id`)
        .all(FINGERPRINT_VERSION, result.fingerprint, packId);
      getDb().prepare(`UPDATE pack_verifications SET version = ?, status = 'completed', fingerprint = ?,
        file_count = ?, total_bytes = ?, checked_at = datetime('now'), matches = ?, error = NULL WHERE pack_id = ?`)
        .run(FINGERPRINT_VERSION, result.fingerprint, result.fileCount, result.totalBytes, JSON.stringify(matches), packId);
      advanceAfterVerification(packId);
    })();
  } else if (getPack(packId)?.status === 'verifying') {
    getDb().transaction(() => advanceAfterVerification(packId))();
  }
}
