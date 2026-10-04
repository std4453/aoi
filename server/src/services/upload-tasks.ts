import fs from 'node:fs';
import path from 'node:path';
import type { CreateUploadTaskRequest, UploadTask } from '../../../shared/types.js';
import { getDb } from '../db/connection.js';
import { createPack, createJob, getJob, setPackTags, getPack, getPackFiles, listPacks, getLatestJob, hasAnyActiveJob, updatePackStatus } from '../db/repositories.js';
import { createUploadTask, getUploadTask, listUploadTasks, updateUploadTask, getUploadTaskMetadata, updateUploadTaskMetadata } from '../db/upload-task-repository.js';
import { getLiveMatches, getVerification, scheduleVerification } from './content-verification.js';
import { jobQueue } from './job-queue.js';
import { getArchivePath, getUploadPath, ensureDir } from './storage.js';
import { parseFanboxUrl } from './fanbox-client.js';
import { parsePixivUrl } from './pixiv-importer.js';
import { isArchivePasswordError } from './archive-errors.js';

export * from '../db/upload-task-repository.js';

/** Persist the task, pack and queued download together before starting network work. */
export function createPixivUploadTask(input: CreateUploadTaskRequest): UploadTask {
  return createPostUploadTask({ ...input, source: 'pixiv' });
}

export function createPostUploadTask(input: CreateUploadTaskRequest): UploadTask {
  if (input.source !== 'pixiv' && input.source !== 'fanbox') throw new Error('Invalid post source');
  const source = input.source;
  const artwork = (source === 'fanbox' ? parseFanboxUrl : parsePixivUrl)(input.url!);
  const task = getDb().transaction(() => {
    const created = createUploadTask({ ...input, source, url: artwork.url });
    const pack = createPack({ name: input.name, originalFilename: artwork.url,
      originalSize: 0, originalFormat: source, sourceType: 'folder' });
    setPackTags(pack.id, input.tagIds ?? []);
    const job = createJob(pack.id, source);
    getDb().prepare('UPDATE jobs SET options = ? WHERE id = ?')
      .run(JSON.stringify({ autoName: input.autoName ?? false, autoTags: input.tagIds === undefined }), job.id);
    return updateUploadTask(created.id, { packId: pack.id })!;
  })();
  jobQueue.start();
  return task;
}

export function syncUploadTask(task: UploadTask): UploadTask {
  if (!task.packId && task.status === 'duplicate') {
    const matches = task.matches.flatMap(match => {
      const pack = getPack(match.id);
      return pack ? [{ id: pack.id, name: pack.name, status: pack.status }] : [];
    });
    return JSON.stringify(matches) === JSON.stringify(task.matches) ? task : updateUploadTask(task.id, { matches })!;
  }
  if (!task.packId || task.status === 'completed') return task;
  const pack = getPack(task.packId);
  let patch: Partial<UploadTask>;
  let processing: UploadTask['processing'];
  if (!pack) {
    patch = { status: 'failed', error: '图包已被删除' };
  } else if (['extracted', 'generated', 'generating'].includes(pack.status)) {
    patch = { status: 'completed', progress: 100, transferredBytes: task.totalBytes, error: null, matches: [] };
  } else if (pack.status === 'awaiting_confirmation') {
    patch = { status: 'duplicate', matches: getLiveMatches(pack.id), transferredBytes: task.totalBytes, error: null };
  } else if (pack.status === 'failed') {
    const password = isArchivePasswordError(pack.errorMessage ?? '');
    const interrupted = pack.sourceType === 'folder' && /上传中断/.test(pack.errorMessage ?? '');
    patch = { status: interrupted ? 'needs_file' : password ? 'password' : 'failed',
      error: pack.errorMessage, ...(password ? { passwordKind: 'archive' as const } : {}) };
  } else if (pack.status === 'uploading' && (task.source === 'pixiv' || task.source === 'fanbox')) {
    const job = getLatestJob(pack.id, task.source);
    const progress = job ? jobQueue.getProgress(job.id) : null;
    patch = { status: 'downloading', progress: progress?.percentage ?? job?.progress ?? 0,
      transferredBytes: progress?.totalOriginalSize ?? 0, error: null, matches: [] };
  } else if (pack.status === 'uploading' && pack.sourceType === 'folder') {
    // A local transfer can fail while its pack is still accepting files. It is
    // resumable by reselection after a reload, unlike a failed processing job.
    if (task.source !== 'folder' || task.status !== 'failed') return task;
    patch = { status: 'needs_file' };
  } else if (pack.status === 'uploading' && task.source === 'mega' && task.status === 'failed' && !hasAnyActiveJob(pack.id)) {
    // Keep handoff errors visible until the durable download journal is retried.
    return task;
  } else {
    const stage = pack.status === 'thumbnailing' || pack.status === 'verifying' || pack.status === 'extracting' ? pack.status : 'preparing';
    const type = stage === 'thumbnailing' ? 'thumbnail' : stage === 'verifying' ? 'verify' : 'extract';
    const job = stage === 'preparing' ? undefined : getLatestJob(pack.id, type);
    const progress = job ? jobQueue.getProgress(job.id) : null;
    processing = { stage, queued: stage !== 'preparing' && (!job || job.status === 'pending'),
      completed: progress?.completed ?? 0, total: progress?.total ?? 0 };
    patch = { status: 'processing', progress: progress?.percentage ?? 0,
      transferredBytes: task.totalBytes, error: null, matches: [] };
  }
  if (pack && (task.source === 'pixiv' || task.source === 'fanbox')) Object.assign(patch, { name: pack.name, totalBytes: pack.originalSize,
    ...(['completed', 'processing', 'duplicate'].includes(patch.status ?? '') ? { transferredBytes: pack.originalSize } : {}) });
  const changed = !Object.entries(patch).every(([key, value]) => JSON.stringify(task[key as keyof UploadTask]) === JSON.stringify(value));
  const updated = changed ? updateUploadTask(task.id, patch)! : task;
  if (changed && updated.status === 'completed') updateUploadTaskMetadata(task.id, { archivePassword: undefined, sharePassword: undefined });
  return processing ? { ...updated, processing } : updated;
}

export function getSyncedUploadTask(id: string): UploadTask | undefined {
  const task = getUploadTask(id);
  return task ? syncUploadTask(task) : undefined;
}

export function listSyncedUploadTasks(): UploadTask[] {
  return listUploadTasks().map(syncUploadTask);
}

export function recoverUploadTasks(): void {
  const tracked = new Set(listUploadTasks().map(task => task.packId));
  for (const pack of listPacks().reverse()) {
    if (pack.sourceType !== 'folder' || tracked.has(pack.id)) continue;
    const verification = getVerification(pack.id);
    const pending = ((pack.originalFormat === 'pixiv' || pack.originalFormat === 'fanbox') && ['uploading', 'verifying', 'thumbnailing', 'failed'].includes(pack.status)) || ['uploading', 'awaiting_confirmation'].includes(pack.status) ||
      (pack.status === 'failed' && /上传中断/.test(pack.errorMessage ?? '')) ||
      (verification?.historical === 0 && (['verifying', 'thumbnailing'].includes(pack.status) ||
        (pack.status === 'failed' && verification.status === 'failed')));
    if (!pending) continue;
    const task = createUploadTask({ source: (pack.originalFormat === 'pixiv' || pack.originalFormat === 'fanbox') ? pack.originalFormat : 'folder', name: pack.name, filename: pack.originalFilename,
      fileSize: pack.originalSize, tagIds: pack.tags.map(tag => tag.id),
      ...((pack.originalFormat === 'pixiv' || pack.originalFormat === 'fanbox') ? { url: pack.originalFilename } : {}) });
    const transferredBytes = getPackFiles(pack.id).filter(file => file.status === 'uploaded').reduce((sum, file) => sum + file.fileSize, 0);
    updateUploadTask(task.id, { packId: pack.id, transferredBytes, progress: pack.originalSize ? transferredBytes / pack.originalSize * 100 : 0 });
  }
  for (const task of listUploadTasks()) {
    if (['archive', 'folder'].includes(task.source) && ['uploading', 'paused'].includes(task.status)) {
      updateUploadTask(task.id, { status: 'needs_file', error: '请重新选择原文件以继续上传' });
    }
    syncUploadTask(getUploadTask(task.id)!);
  }
}

/** Recover a crash after durable task/pack binding and before the archive rename. */
export function recoverArchiveTaskFiles(): void {
  for (const task of listUploadTasks()) {
    if (task.source !== 'archive' || !task.packId || !task.uploadId) continue;
    const pack = getPack(task.packId);
    if (!pack || pack.sourceType !== 'archive' || pack.status !== 'uploading') continue;
    try {
      const destination = getArchivePath(pack.id, `original.${pack.originalFormat}`);
      if (fs.existsSync(destination)) continue;
      const source = getUploadPath(task.uploadId);
      if (!fs.existsSync(source)) continue;
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size !== pack.originalSize) continue;
      ensureDir(path.dirname(destination));
      fs.renameSync(source, destination);
      for (const suffix of ['.info', '.json']) fs.rmSync(source + suffix, { force: true });
    } catch (error) {
      updatePackStatus(pack.id, 'failed', `无法恢复压缩包上传：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function retryPackTask(task: UploadTask, archivePassword?: string): Promise<void> {
  if (!task.packId) return;
  const pack = getPack(task.packId);
  if (!pack) throw new Error('Pack not found');
  if (hasAnyActiveJob(pack.id)) throw new Error('图包正在处理');
  if (pack.sourceType === 'folder' && task.status === 'needs_file') {
    updatePackStatus(pack.id, 'uploading');
    updateUploadTask(task.id, { status: 'uploading', error: null });
    return;
  }
  if (pack.status !== 'failed') throw new Error('仅失败任务可以重试');
  if (task.source === 'pixiv' || task.source === 'fanbox') {
    const row = getDb().prepare("SELECT id FROM jobs WHERE pack_id = ? AND type != 'compress' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(pack.id) as { id: string } | undefined;
    const latest = row ? getJob(row.id) : undefined;
    if (!latest || ![task.source, 'verify', 'thumbnail'].includes(latest.type)) throw new Error('无法重试此导入任务');
    getDb().transaction(() => {
      if (latest.type === 'verify') scheduleVerification(pack.id);
      else {
        updatePackStatus(pack.id, latest.type === task.source ? 'uploading' : 'thumbnailing');
        const next = createJob(pack.id, latest.type);
        if (latest.options) getDb().prepare('UPDATE jobs SET options = ? WHERE id = ?').run(latest.options, next.id);
      }
      updateUploadTask(task.id, { status: latest.type === task.source ? 'downloading' : 'processing', error: null, progress: 0 });
    })();
    jobQueue.start();
    return;
  } else if (getVerification(pack.id)?.status === 'failed') {
    scheduleVerification(pack.id);
    jobQueue.start();
  } else if (pack.sourceType === 'archive') {
    if (!fs.existsSync(getArchivePath(pack.id, `original.${pack.originalFormat}`))) throw new Error('原始压缩包缺失');
    getDb().prepare('UPDATE packs SET archive_password = ? WHERE id = ?')
      .run(archivePassword ?? getUploadTaskMetadata(task.id).archivePassword ?? null, pack.id);
    updatePackStatus(pack.id, 'extracting');
    await jobQueue.enqueueUnique(pack.id, 'extract');
  } else {
    updatePackStatus(pack.id, 'thumbnailing');
    await jobQueue.enqueueUnique(pack.id, 'thumbnail');
  }
  updateUploadTask(task.id, { status: 'processing', error: null, passwordKind: undefined });
}
