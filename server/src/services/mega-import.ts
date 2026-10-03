import fs from 'node:fs';
import path from 'node:path';
import type { UploadTask } from '../../../shared/types.js';
import { getDb } from '../db/connection.js';
import { createPack, getPack, setPackTags, findArchiveDuplicates, updatePackStats, updatePackStructureType, hasAnyActiveJob,
  createPackFiles, getPackFiles, completePackFile } from '../db/repositories.js';
import { getUploadTask, getUploadTaskMetadata, listUploadTasks, updateUploadTask, updateUploadTaskMetadata } from './upload-tasks.js';
import { getArchivePath, getFolderStagingDir, getUploadPath, ensureDir } from './storage.js';
import { resolveWithin } from './safe-path.js';
import { downloadMegaShare, megaShareTitle, type MegaDownloadResult } from './mega-download.js';
import { MegaPasswordError } from './mega-link.js';
import { hashArchive, backfillArchiveHashes } from './archive-deduplication.js';
import { folderProcessor } from './folder-processor.js';
import { scheduleVerification, continueFolderVerification } from './content-verification.js';
import { jobQueue } from './job-queue.js';
import { beginMutation } from '../replication/state.js';

export { validateMegaUrl } from './mega-link.js';

interface MegaImportOptions {
  url?: string;
  name?: string;
  autoName?: boolean;
  sharePassword?: string;
  archivePassword?: string;
  tagIds?: string[];
}

const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();

function importDirectory(id: string): string {
  return getUploadPath(`mega-${id}`);
}

async function finishImport(id: string, result: MegaDownloadResult, options: MegaImportOptions, allowDuplicate: boolean, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const task = getUploadTask(id);
  if (!task) return;
  let pack = task.packId ? getPack(task.packId) : undefined;
  const archive = result.kind === 'archive';
  const format = archive ? path.extname(result.name).slice(1).toLowerCase() : 'folder';
  let archiveMd5: string | undefined;
  if (archive && !pack) {
    archiveMd5 = await hashArchive(result.contentPath);
    await backfillArchiveHashes(result.totalBytes);
    signal.throwIfAborted();
    const matches = findArchiveDuplicates(archiveMd5);
    if (matches.length && !allowDuplicate) {
      updateUploadTask(id, { status: 'duplicate', matches, progress: 100, error: null });
      return;
    }
  }
  signal.throwIfAborted();
  if (!pack) {
    getDb().transaction(() => {
      pack = createPack({ name: options.autoName || !options.name ? megaShareTitle(result.name, result.kind) : options.name.slice(0, 200),
        originalFilename: result.name, originalSize: result.totalBytes, originalFormat: format,
        sourceType: archive ? 'archive' : 'folder', archivePassword: options.archivePassword, archiveMd5,
      });
      if (options.tagIds?.length) setPackTags(pack.id, options.tagIds);
      if (!archive) createPackFiles(pack.id, result.files);
      updateUploadTask(id, { packId: pack.id, name: pack.name, status: 'processing', progress: 0, matches: [], error: null });
    })();
  }
  if (!pack) throw new Error('无法创建导入图包');
  updateUploadTask(id, { status: 'processing', error: null, progress: 0 });
  if (archive) {
    const destination = getArchivePath(pack.id, `original.${format}`);
    ensureDir(path.dirname(destination));
    if (!fs.existsSync(destination)) fs.renameSync(result.contentPath, destination);
    await jobQueue.enqueueUnique(pack.id, 'extract');
  } else {
    const staging = getFolderStagingDir(pack.id);
    if (fs.existsSync(result.contentPath) && !fs.existsSync(staging)) {
      ensureDir(path.dirname(staging));
      fs.renameSync(result.contentPath, staging);
    }
    for (const file of getPackFiles(pack.id)) completePackFile(file.id);
    const stats = folderProcessor.processUploadedFolder(pack.id);
    updatePackStats(pack.id, stats);
    updatePackStructureType(pack.id, stats.structureType);
    scheduleVerification(pack.id);
    jobQueue.start();
  }
  // Once materialized, ordinary durable extraction/verification jobs own recovery.
  updateUploadTaskMetadata(id, { sharePassword: undefined });
  fs.rmSync(importDirectory(id), { recursive: true, force: true });
}

async function runImport(id: string, options: MegaImportOptions, signal: AbortSignal, allowDuplicate: boolean): Promise<void> {
  const task = getUploadTask(id);
  if (!task) return;
  const directory = importDirectory(id);
  const journal = resolveWithin(directory, 'download.json');
  try {
    updateUploadTask(id, { status: 'downloading', error: null, passwordKind: undefined, matches: [] });
    let result: MegaDownloadResult;
    if (fs.existsSync(journal)) {
      result = JSON.parse(fs.readFileSync(journal, 'utf8')) as MegaDownloadResult;
      // Reconstruct filesystem locations from the task id, never from persisted absolute paths.
      const contents = resolveWithin(directory, 'contents');
      result.contentPath = result.kind === 'folder' ? contents : resolveWithin(contents, result.name);
    } else {
      if (!options.url) throw new Error('MEGA 分享链接缺失');
      let lastUpdate = 0;
      result = await downloadMegaShare({ url: options.url, sharePassword: options.sharePassword,
        destination: directory, signal,
        onProgress: progress => {
          if (progress.transferredBytes !== progress.totalBytes && Date.now() - lastUpdate < 200) return;
          lastUpdate = Date.now();
          updateUploadTask(id, { filename: progress.name, totalBytes: progress.totalBytes,
            ...(options.autoName ? { name: megaShareTitle(progress.name, progress.kind) } : {}),
            transferredBytes: progress.transferredBytes,
            progress: progress.totalBytes ? Math.floor(progress.transferredBytes / progress.totalBytes * 100) : 0,
          });
        },
      });
      const temporaryJournal = resolveWithin(directory, 'download.json.tmp');
      fs.writeFileSync(temporaryJournal, JSON.stringify(result));
      fs.renameSync(temporaryJournal, journal);
    }
    if (options.autoName) updateUploadTask(id, { name: megaShareTitle(result.name, result.kind) });
    const endMutation = beginMutation();
    try {
      await finishImport(id, result, options, allowDuplicate, signal);
    } finally {
      endMutation();
    }
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    const password = error instanceof MegaPasswordError;
    updateUploadTask(id, { status: password ? 'password' : 'failed', error: message.slice(0, 1_000),
      ...(password ? { passwordKind: 'share' as const } : {}),
    });
  }
}

/** Starts in the background; the persisted task is the source of truth for its outcome. */
export function startMegaImport(id: string, options: MegaImportOptions, allowDuplicate = false): Promise<void> {
  const existing = active.get(id);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const promise = runImport(id, options, controller.signal, allowDuplicate).finally(() => active.delete(id));
  active.set(id, { controller, promise });
  return promise;
}

export async function continueMegaImport(id: string): Promise<void> {
  const task = getUploadTask(id);
  if (!task) return;
  if (task.packId) {
    continueFolderVerification(task.packId);
    updateUploadTask(id, { status: 'processing', matches: [], error: null });
    jobQueue.start();
    return;
  }
  await startMegaImport(id, { ...getUploadTaskMetadata(id), name: task.name }, true);
}

export async function cancelMegaImport(id: string): Promise<void> {
  const job = active.get(id);
  job?.controller.abort();
  await job?.promise;
  fs.rmSync(importDirectory(id), { recursive: true, force: true });
}

export async function shutdownMegaImports(): Promise<void> {
  const jobs = [...active.values()];
  for (const job of jobs) job.controller.abort();
  await Promise.all(jobs.map(job => job.promise));
}

/** A bound pack without a job still belongs to the durable download handoff. */
export function hasPendingMegaHandoff(task: UploadTask): boolean {
  if (task.source !== 'mega' || !task.packId) return false;
  const pack = getPack(task.packId);
  return pack?.status === 'uploading' && !hasAnyActiveJob(pack.id)
    && fs.existsSync(resolveWithin(importDirectory(task.id), 'download.json'));
}

/** Complete a crash between pack publication and moving its downloaded content before ordinary job recovery. */
export async function recoverMegaImports(): Promise<void> {
  for (const task of listUploadTasks()) {
    if (!['processing', 'downloading', 'failed'].includes(task.status) || !hasPendingMegaHandoff(task)) continue;
    await startMegaImport(task.id, { ...getUploadTaskMetadata(task.id), name: task.name }, true);
  }
}
