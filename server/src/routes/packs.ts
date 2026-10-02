import { scheduleVerification, getVerification, getLiveMatches, continueFolderVerification } from '../services/content-verification.js';
import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import type { ArchiveUploadRequest, UploadTaskStatus } from '../../../shared/types.js';
import { getDb } from '../db/connection.js';
import { hashArchive, backfillArchiveHashes, withUploadLock } from '../services/archive-deduplication.js';
import path from 'node:path';
import {
  listPacks,
  findArchiveDuplicates,
  listPacksPaginated,
  getPack,
  getJob,
  createJob,
  deletePack as deletePackFromDb,
  createPack,
  updatePackStatus,
  updatePackStats,
  updatePackStructureType,
  renamePack as renamePackInDb,
  listTags as listTagsFromDb,
  createTag as createTagInDb,
  renameTag as renameTagInDb,
  deleteTag as deleteTagFromDb,
  setPackTags as setPackTagsInDb,
  getPackBlurhashes,
  createPackFiles,
  getPackFiles,
  getPackFile,
  updatePackFileUploadId,
  completePackFile,
  getPendingPackFileCount,
  hasAnyActiveJob,
  toPublicPack,
} from '../db/repositories.js';
import { removePackFiles, ensureDir, getArchivePath, getThumbnailsDir, getExtractedImagesDir, getExtractedVideosDir, getFolderStagingDir, getUploadPath, getPath } from '../services/storage.js';
import { config } from '../config.js';
import { jobQueue } from '../services/job-queue.js';
import { normalizeRelativePath, resolveWithin } from '../services/safe-path.js';
import { buildJpegOutputPaths } from '../services/jpeg-output-path.js';
import { folderProcessor } from '../services/folder-processor.js';
import { isUgoira, readUgoiraFrame, readUgoiraManifest } from '../services/ugoira.js';
import { safeContentFile } from '../replication/protocol.js';

const MAX_NAME_LENGTH = 200;
const MAX_FILENAME_LENGTH = 255;
const MAX_PASSWORD_LENGTH = 1_024;
const MAX_TAGS_PER_PACK = 1_000;

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function validateName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[\0\r\n]/.test(name)) {
    throw new Error(`${label} must contain 1-${MAX_NAME_LENGTH} safe characters`);
  }
  return name;
}

function validateTagIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS_PER_PACK) {
    throw new Error('Invalid tag list');
  }
  if (value.some(id => typeof id !== 'string')) {
    throw new Error('Invalid tag list');
  }
  const uniqueIds = [...new Set(value)];
  const existingIds = new Set(listTagsFromDb().map(tag => tag.id));
  if (uniqueIds.some(id => !existingIds.has(id))) {
    throw new Error('One or more tags do not exist');
  }
  return uniqueIds;
}

function encodeRelativePathForUrl(value: string): string {
  return value.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

async function finishFolderPackIfReady(packId: string): Promise<boolean> {
  if (getPendingPackFileCount(packId) !== 0) return false;

  const result = folderProcessor.processUploadedFolder(packId);
  updatePackStats(packId, result);
  updatePackStructureType(packId, result.structureType);
  scheduleVerification(packId);
  jobQueue.start();
  return true;
}

export const registerPackRoutes: FastifyPluginAsync = async function (fastify) {
  const latestImportJob = (id: string) => {
    const row = getDb().prepare("SELECT id FROM jobs WHERE pack_id = ? AND type != 'compress' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as { id: string } | undefined;
    return row ? getJob(row.id) : undefined;
  };
  fastify.get<{ Params: { id: string } }>('/api/packs/:id/upload-task', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) return reply.code(404).send({ error: '图包不存在或已删除' });
    const job = latestImportJob(pack.id);
    return { pack: toPublicPack(pack), progress: job ? jobQueue.getProgress(job.id) : null,
      matches: pack.status === 'awaiting_confirmation' ? getLiveMatches(pack.id) : [],
      retryable: pack.status === 'failed' && Boolean(job && ['pixiv', 'verify', 'thumbnail'].includes(job.type)) && !hasAnyActiveJob(pack.id),
    } satisfies UploadTaskStatus;
  });
  fastify.post<{ Params: { id: string } }>('/api/packs/:id/upload-task/retry', async (request, reply) => {
    return withUploadLock(`folder-${request.params.id}`, async () => {
      const pack = getPack(request.params.id);
      if (!pack) return reply.code(404).send({ error: '图包不存在或已删除' });
      const job = latestImportJob(pack.id);
      if (pack.status !== 'failed' || hasAnyActiveJob(pack.id) || !job || !['pixiv', 'verify', 'thumbnail'].includes(job.type)) {
        return reply.code(409).send({ error: '当前任务无法重试，请删除后重新上传' });
      }
      getDb().transaction(() => {
        if (job.type === 'verify') scheduleVerification(pack.id);
        else {
          updatePackStatus(pack.id, job.type === 'pixiv' ? 'uploading' : 'thumbnailing');
          const next = createJob(pack.id, job.type);
          if (job.options) getDb().prepare('UPDATE jobs SET options = ? WHERE id = ?').run(job.options, next.id);
        }
      })();
      jobQueue.start();
      return { ok: true };
    });
  });
  fastify.post<{ Params: { id: string } }>('/api/packs/:id/upload-task/continue', async (request, reply) => {
    return withUploadLock(`folder-${request.params.id}`, async () => {
      const pack = getPack(request.params.id);
      if (!pack) return reply.code(404).send({ error: '图包不存在或已删除' });
      if (pack.status !== 'awaiting_confirmation') return reply.code(409).send({ error: '当前任务无需重复确认' });
      continueFolderVerification(pack.id);
      jobQueue.start();
      return { ok: true };
    });
  });
  fastify.delete<{ Params: { id: string } }>('/api/packs/:id/upload-task', async (request, reply) => {
    return withUploadLock(`folder-${request.params.id}`, async () => {
      const pack = getPack(request.params.id);
      if (!pack) return { ok: true };
      try { await jobQueue.cancelImport(pack.id); }
      catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : '取消失败，请重试' }); }
      for (const file of getPackFiles(pack.id)) {
        if (file.uploadId) for (const suffix of ['', '.json', '.info']) fs.rmSync(getUploadPath(file.uploadId) + suffix, { force: true });
      }
      removePackFiles(pack.id);
      deletePackFromDb(pack.id);
      return { ok: true };
    });
  });
  // List packs (paginated, with search)
  fastify.get<{
    Querystring: { page?: string; pageSize?: string; search?: string };
  }>('/api/packs', async (request, reply) => {
    try {
      const { page, pageSize, search } = request.query;
      if (search && search.length > 200) {
        throw new Error('Search query is too long');
      }
      const result = listPacksPaginated({
        page: parsePositiveInteger(page, 'page'),
        pageSize: parsePositiveInteger(pageSize, 'pageSize'),
        search: search || undefined,
      });
      return { ...result, items: result.items.map(toPublicPack) };
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Get single pack (with tags)
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    return toPublicPack(pack);
  });

  // List all tags (with usage count and sample covers)
  fastify.get('/api/tags', async () => {
    const tags = listTagsFromDb();
    const packs = listPacks();
    const usageCount = new Map<string, number>();
    const tagCovers = new Map<string, string[]>();
    for (const pack of packs) {
      for (const tag of pack.tags) {
        usageCount.set(tag.id, (usageCount.get(tag.id) || 0) + 1);
        const covers = tagCovers.get(tag.id) || [];
        if (covers.length < 8) {
          covers.push(`/api/packs/${pack.id}/cover`);
        }
        tagCovers.set(tag.id, covers);
      }
    }
    return tags.map(tag => ({
      ...tag,
      count: usageCount.get(tag.id) || 0,
      covers: tagCovers.get(tag.id) || [],
    }));
  });

  // Create a tag
  fastify.post<{
    Body: { name: string };
  }>('/api/tags', async (request, reply) => {
    try {
      const name = validateName(request.body?.name, 'Tag name');
      return createTagInDb(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.includes('UNIQUE') ? 409 : 400).send({
        error: message.includes('UNIQUE') ? 'Tag already exists' : message,
      });
    }
  });

  // Rename a tag
  fastify.patch<{
    Params: { id: string };
    Body: { name: string };
  }>('/api/tags/:id', async (request, reply) => {
    const tag = listTagsFromDb().find(t => t.id === request.params.id);
    if (!tag) {
      reply.code(404).send({ error: 'Tag not found' });
      return;
    }
    let newName: string;
    try {
      newName = validateName(request.body?.name, 'Tag name');
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      return renameTagInDb(tag.id, newName);
    } catch (err) {
      reply.code(409).send({ error: 'Tag name already exists' });
      return;
    }
  });

  // Get packs by tag
  fastify.get<{
    Params: { id: string };
  }>('/api/tags/:id/packs', async (request, reply) => {
    const tag = listTagsFromDb().find(t => t.id === request.params.id);
    if (!tag) {
      reply.code(404).send({ error: 'Tag not found' });
      return;
    }
    const allPacks = listPacks();
    return allPacks.filter(p => p.tags.some(t => t.id === tag.id)).map(toPublicPack);
  });

  // Delete a tag
  fastify.delete<{
    Params: { id: string };
  }>('/api/tags/:id', async (request, reply) => {
    const tag = listTagsFromDb().find(t => t.id === request.params.id);
    if (!tag) {
      reply.code(404).send({ error: 'Tag not found' });
      return;
    }
    deleteTagFromDb(tag.id);
    return { ok: true };
  });

  // Update pack tags
  fastify.put<{
    Params: { id: string };
    Body: { tagIds: string[] };
  }>('/api/packs/:id/tags', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    try {
      if (!request.body || !Object.hasOwn(request.body, 'tagIds')) {
        throw new Error('tagIds is required');
      }
      const tagIds = validateTagIds(request.body.tagIds);
      setPackTagsInDb(pack.id, tagIds);
      return toPublicPack(getPack(pack.id)!);
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Delete a pack
  fastify.delete<{
    Params: { id: string };
  }>('/api/packs/:id', async (request, reply) => {
    return withUploadLock(`folder-${request.params.id}`, async () => {
      const pack = getPack(request.params.id);
      if (!pack) {
        reply.code(404).send({ error: 'Pack not found' });
        return;
      }
      try {
        await jobQueue.cancelVerification(pack.id);
      } catch {
        reply.code(409).send({ error: 'Pack is currently being processed and cannot be deleted' });
        return;
      }
      if (hasAnyActiveJob(pack.id)) {
        reply.code(409).send({ error: 'Pack is currently being processed and cannot be deleted' });
        return;
      }
      removePackFiles(pack.id);
      deletePackFromDb(pack.id);
      return { ok: true };
    });
  });

  // Rename a pack
  fastify.patch<{
    Params: { id: string };
    Body: { name: string };
  }>('/api/packs/:id', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    let newName: string;
    try {
      newName = validateName(request.body.name, 'Pack name');
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const updated = renamePackInDb(pack.id, newName);
    return toPublicPack(updated!);
  });

  // Confirm upload completion and start processing
  fastify.post<{
    Body: ArchiveUploadRequest;
  }>('/api/packs/upload-complete', async (request, reply) => {
    const {
      uploadId,
      filename,
      fileSize: _fileSize,
      packName,
      archivePassword,
      tagIds,
      allowDuplicate,
    } = request.body ?? {};

    return withUploadLock(uploadId, async () => {
      let safeFilename: string;
      let packNameToUse: string;
      let safeTagIds: string[];
      try {
        if (allowDuplicate !== undefined && typeof allowDuplicate !== 'boolean') throw new Error('Invalid duplicate confirmation');
        if (typeof filename !== 'string' || path.basename(filename) !== filename) {
          throw new Error('Invalid filename');
        }
        safeFilename = validateName(filename, 'Filename');
        if (safeFilename.length > MAX_FILENAME_LENGTH) throw new Error('Filename is too long');
        packNameToUse = validateName(
          packName ?? path.basename(safeFilename, path.extname(safeFilename)),
          'Pack name'
        );
        if (
          archivePassword !== undefined &&
          (typeof archivePassword !== 'string' || archivePassword.length > MAX_PASSWORD_LENGTH)
        ) {
          throw new Error('Archive password is too long');
        }
        safeTagIds = validateTagIds(tagIds);
      } catch (error) {
        reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }

      let uploadPath: string;
      try {
        uploadPath = getUploadPath(uploadId);
      } catch {
        reply.code(400).send({ error: 'Invalid upload id' });
        return;
      }

      if (!fs.existsSync(uploadPath)) {
        reply.code(404).send({ error: 'Upload file not found' });
        return;
      }

      const actualSize = fs.statSync(uploadPath).size;
      if (actualSize <= 0 || actualSize > config.maxUploadSize) {
        reply.code(400).send({ error: 'Uploaded file size is invalid' });
        return;
      }

      const ext = path.extname(safeFilename).toLowerCase().replace('.', '');
      if (!['zip', 'rar', '7z'].includes(ext)) {
        reply.code(400).send({ error: 'Unsupported format. Only ZIP, RAR and 7z are supported.' });
        return;
      }

      try {
        const archiveMd5 = await hashArchive(uploadPath);
        await backfillArchiveHashes(actualSize);
        const matches = findArchiveDuplicates(archiveMd5);
        if (matches.length > 0 && !allowDuplicate) {
          return reply.code(409).send({ code: 'DUPLICATE_ARCHIVE', matches });
        }
        const pack = createPack({
          name: packNameToUse,
          originalFilename: safeFilename,
          originalSize: actualSize,
          originalFormat: ext,
          archivePassword,
          archiveMd5,
        });

        // Set tags if provided
        if (safeTagIds.length > 0) {
          setPackTagsInDb(pack.id, safeTagIds);
        }

        // Move uploaded file to archives directory
        const archiveDir = path.join(config.dirs.archives, pack.id);
        ensureDir(archiveDir);
        const archivePath = getArchivePath(pack.id, `original.${ext}`);
        fs.renameSync(uploadPath, archivePath);

        const infoPath = `${uploadPath}.info`;
        if (fs.existsSync(infoPath)) {
          fs.unlinkSync(infoPath);
        }

        // Start extraction job
        await jobQueue.enqueue(pack.id, 'extract');

        // Return pack with tags
        return toPublicPack(getPack(pack.id)!);
      } catch (err) {
        console.error('[upload-complete] Error:', err);
        reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  // Create a folder-type pack (before uploading individual files)
  fastify.post<{
    Body: {
      packName: string;
      files: { relativePath: string; fileSize: number }[];
      tagIds?: string[];
    };
  }>('/api/packs/folder-create', async (request, reply) => {
    const { packName, files, tagIds } = request.body ?? {};

    if (!Array.isArray(files) || files.length === 0) {
      reply.code(400).send({ error: 'Files list cannot be empty' });
      return;
    }
    if (files.length > config.maxArchiveEntries) {
      reply.code(400).send({ error: `Too many files (maximum ${config.maxArchiveEntries})` });
      return;
    }

    let safePackName: string;
    let normalizedFiles: { relativePath: string; fileSize: number }[];
    let safeTagIds: string[];
    try {
      safePackName = validateName(packName, 'Pack name');
      const validatedFiles = files.map(file => {
        if (!Number.isSafeInteger(file.fileSize) || file.fileSize < 0) {
          throw new Error('Invalid file size');
        }
        return {
          relativePath: normalizeRelativePath(file.relativePath, 'folder file path'),
          fileSize: file.fileSize,
        };
      });
      const uniquePaths = new Set(validatedFiles.map(file => file.relativePath));
      if (uniquePaths.size !== validatedFiles.length) {
        throw new Error('Folder contains duplicate file paths');
      }
      const totalSize = validatedFiles.reduce((sum, file) => sum + file.fileSize, 0);
      if (!Number.isSafeInteger(totalSize) || totalSize > config.maxExtractedSize) {
        throw new Error('Folder exceeds the configured size limit');
      }
      safeTagIds = validateTagIds(tagIds);
      normalizedFiles = validatedFiles;
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    try {
      const pack = createPack({
        name: safePackName,
        originalFilename: safePackName,
        originalSize: normalizedFiles.reduce((sum, file) => sum + file.fileSize, 0),
        originalFormat: 'folder',
        sourceType: 'folder',
      });

      createPackFiles(pack.id, normalizedFiles);

      if (safeTagIds.length > 0) {
        setPackTagsInDb(pack.id, safeTagIds);
      }

      // Create staging directory
      const stagingDir = getFolderStagingDir(pack.id);
      ensureDir(stagingDir);

      const packFiles = getPackFiles(pack.id);
      return { id: pack.id, packFiles };
    } catch (err) {
      console.error('[folder-create] Error:', err);
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Confirm a single file upload for a folder pack
  fastify.post<{
    Params: { id: string };
    Body: {
      packFileId: string;
      uploadId: string;
    };
  }>('/api/packs/:id/folder-file-complete', async (request, reply) => {
    const { id } = request.params;
    const { packFileId, uploadId } = request.body ?? {};

    return withUploadLock(`folder-${id}`, async () => {
      const pack = getPack(id);
      if (!pack) {
        reply.code(404).send({ error: 'Pack not found' });
        return;
      }
      const existingFile = getPackFile(packFileId);
      if (pack.sourceType === 'folder' && existingFile?.packId === id && existingFile.status === 'uploaded' && pack.status !== 'uploading') {
        return { allComplete: true };
      }
      if (pack.sourceType !== 'folder' || pack.status !== 'uploading') {
        reply.code(400).send({ error: 'Pack is not a folder upload in uploading state' });
        return;
      }

      const packFile = getPackFile(packFileId);
      if (!packFile || packFile.packId !== id) {
        reply.code(400).send({ error: 'Pack file does not belong to this pack' });
        return;
      }

      try {
        // Move uploaded file from tus uploads dir to staging dir
        let uploadPath: string;
        try {
          uploadPath = getUploadPath(uploadId);
        } catch {
          reply.code(400).send({ error: 'Invalid upload id' });
          return;
        }
        const stagingDir = getFolderStagingDir(id);
        const destRelativePath = packFile.relativePath;
        const destPath = resolveWithin(stagingDir, destRelativePath, 'folder file path');
        if (fs.existsSync(destPath)) {
          const destinationStat = fs.statSync(destPath);
          if (!destinationStat.isFile() || destinationStat.size !== packFile.fileSize) {
            reply.code(409).send({ error: 'Destination file conflicts with the uploaded file' });
            return;
          }
          // A previous request may have moved the file before the process stopped.
          // Treat a size-matching staged file as an idempotent completion.
          completePackFile(packFileId);
        } else {
          if (!fs.existsSync(uploadPath)) {
            reply.code(404).send({ error: 'Upload file not found' });
            return;
          }
          const actualSize = fs.statSync(uploadPath).size;
          if (actualSize !== packFile.fileSize) {
            reply.code(400).send({ error: 'Uploaded file size does not match the declared size' });
            return;
          }
          ensureDir(path.dirname(destPath));
          // Persist the tus id before the rename for crash recovery and cleanup.
          updatePackFileUploadId(packFileId, uploadId);
          fs.renameSync(uploadPath, destPath);
          completePackFile(packFileId);
        }

        // Clean up current and legacy tus metadata files
        try {
          fs.rmSync(uploadPath + '.info', { force: true });
          fs.rmSync(uploadPath + '.json', { force: true });
        } catch (error) {
          console.warn('[folder-file-complete] Failed to remove tus metadata:', error);
        }

        return { allComplete: await finishFolderPackIfReady(id) };
      } catch (err) {
        console.error('[folder-file-complete] Error:', err);
        reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/packs/:id/folder-upload-status', async (request, reply) => {
    const { id } = request.params;
    return withUploadLock(`folder-${id}`, async () => {
      let pack = getPack(id);
      if (!pack || pack.sourceType !== 'folder') return reply.code(404).send({ error: 'Folder pack not found' });
      const matches = pack.status === 'awaiting_confirmation' ? getLiveMatches(id) : [];
      if (pack.status === 'awaiting_confirmation' && matches.length === 0) {
        continueFolderVerification(id);
        jobQueue.start();
        pack = getPack(id)!;
      }
      return { pack: toPublicPack(pack), matches };
    });
  });

  fastify.post<{ Params: { id: string } }>('/api/packs/:id/folder-continue', async (request, reply) => {
    const { id } = request.params;
    return withUploadLock(`folder-${id}`, async () => {
      const pack = getPack(id);
      if (!pack || pack.sourceType !== 'folder') return reply.code(404).send({ error: 'Folder pack not found' });
      try {
        continueFolderVerification(id);
        jobQueue.start();
        return { ok: true };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  fastify.post<{ Params: { id: string } }>('/api/packs/:id/retry-verification', async (request, reply) => {
    const { id } = request.params;
    return withUploadLock(`folder-${id}`, async () => {
      const record = getVerification(id);
      if (!record || !getPack(id)) return reply.code(404).send({ error: 'Verification not found' });
      if (hasAnyActiveJob(id)) return reply.code(409).send({ error: 'Pack is currently being processed' });
      if (record.status !== 'failed') return reply.code(409).send({ error: 'Verification has not failed' });
      scheduleVerification(id);
      jobQueue.start();
      return { ok: true };
    });
  });

  // Cancel a folder upload — clean up pack and uploaded files
  fastify.delete<{
    Params: { id: string };
  }>('/api/packs/:id/cancel-upload', async (request, reply) => {
    const { id } = request.params;
    return withUploadLock(`folder-${id}`, async () => {
      const pack = getPack(id);

      if (!pack) {
        return { ok: true };
      }
      const verification = getVerification(id);
      if (pack.sourceType !== 'folder' || (pack.status !== 'uploading' && !(pack.status === 'failed' && !verification) && (!verification || verification.historical || verification.approved))) {
        reply.code(400).send({ error: 'Pack is not a folder upload in uploading state' });
        return;
      }

      try {
        await jobQueue.cancelVerification(id);
        // Clean up tus upload files for any uploaded/in-progress files
        const packFiles = getPackFiles(id);
        for (const pf of packFiles) {
          if (pf.uploadId) {
            const uploadPath = getUploadPath(pf.uploadId);
            if (fs.existsSync(uploadPath)) {
              fs.unlinkSync(uploadPath);
            }
            fs.rmSync(uploadPath + '.json', { force: true });
            const infoPath = uploadPath + '.info';
            if (fs.existsSync(infoPath)) {
              fs.unlinkSync(infoPath);
            }
          }
        }

        // Remove extracted/staging files
        removePackFiles(id);

        // Delete pack from database (cascades to pack_files, jobs, pack_tags)
        deletePackFromDb(id);

        return { ok: true };
      } catch (err) {
        console.error('[cancel-upload] Error:', err);
        reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  // Serve original image for preview (supports subdirectory paths)
  fastify.get<{
    Params: { id: string; '*': string };
  }>('/api/packs/:id/images/*', async (request, reply) => {
    if (!getPack(request.params.id)) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    const imagesDir = getExtractedImagesDir(request.params.id);
    const relPath = request.params['*'];
    let resolved: string;
    try {
      resolved = resolveWithin(imagesDir, relPath, 'image path');
    } catch {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      reply.code(404).send({ error: 'Image not found' });
      return;
    }
    if (isUgoira(resolved)) {
      try {
        await safeContentFile(imagesDir, relPath);
        const manifest = await readUgoiraManifest(resolved);
        const mime = path.extname(manifest.frames[0].file).slice(1).replace('jpg', 'jpeg');
        return reply.type(`image/${mime}`).send(await readUgoiraFrame(resolved, 0));
      } catch { return reply.code(400).send({ error: '无法读取 ugoira 预览' }); }
    }
    return reply.sendFile(path.basename(resolved), path.dirname(resolved));
  });

  fastify.get<{ Params: { id: string; '*': string }; Querystring: { frame?: string; download?: string } }>('/api/packs/:id/ugoira/*', async (request, reply) => {
    if (!getPack(request.params.id)) return reply.code(404).send({ error: 'Pack not found' });
    try {
      const file = await safeContentFile(getExtractedImagesDir(request.params.id), request.params['*']);
      if (!isUgoira(file)) return reply.code(400).send({ error: 'Not a ugoira file' });
      if (request.query.download === '1') {
        return reply.type('application/zip').header('Content-Disposition', `attachment; filename="animation.ugoira"`).send(fs.createReadStream(file));
      }
      const manifest = await readUgoiraManifest(file);
      if (request.query.frame === undefined) return manifest;
      if (!/^\d+$/.test(request.query.frame)) return reply.code(400).send({ error: 'Invalid frame' });
      const index = Number(request.query.frame);
      if (!manifest.frames[index]) return reply.code(404).send({ error: 'Frame not found' });
      const mime = path.extname(manifest.frames[index].file).slice(1).replace('jpg', 'jpeg');
      return reply.header('Cache-Control', 'private, max-age=3600').type(`image/${mime}`).send(await readUgoiraFrame(file, index));
    } catch { return reply.code(400).send({ error: '无法读取 ugoira 文件' }); }
  });

  fastify.get<{ Params: { id: string; '*': string } }>('/api/packs/:id/videos/*', async (request, reply) => {
    if (!getPack(request.params.id)) return reply.code(404).send({ error: 'Pack not found' });
    let file: string;
    try { file = resolveWithin(getExtractedVideosDir(request.params.id), request.params['*']); }
    catch { return reply.code(403).send({ error: 'Forbidden' }); }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).send({ error: 'Video not found' });
    return reply.sendFile(path.basename(file), path.dirname(file));
  });

  // Serve thumbnail for a pack (supports subdirectory paths)
  fastify.get<{
    Params: { id: string; '*': string };
  }>('/api/packs/:id/thumbnails/*', async (request, reply) => {
    if (!getPack(request.params.id)) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    const thumbDir = getThumbnailsDir(request.params.id);
    const relPath = request.params['*'];
    let resolved: string;
    try {
      resolved = resolveWithin(thumbDir, relPath, 'thumbnail path');
    } catch {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return reply.code(404).send({ error: 'Thumbnail not found' });
    }
    return reply.sendFile(path.basename(resolved), path.dirname(resolved));
  });

  // Serve cover image (first thumbnail)
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id/cover', async (request, reply) => {
    if (!getPack(request.params.id)) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    const coverDir = getPath('thumbnails', request.params.id);
    const coverPath = path.join(coverDir, '_cover.jpg');
    if (fs.existsSync(coverPath)) {
      return reply.sendFile('_cover.jpg', coverDir);
    }

    // Backward-compatible fallback for packs created before dedicated covers.
    const thumbDir = getThumbnailsDir(request.params.id);
    if (!fs.existsSync(thumbDir)) {
      reply.code(404).send({ error: 'No thumbnails' });
      return;
    }
    const allThumbs = walkDirForExt(thumbDir, '.jpg');
    if (allThumbs.length === 0) {
      reply.code(404).send({ error: 'No thumbnails' });
      return;
    }
    allThumbs.sort();
    const firstRel = allThumbs[0];
    const resolved = path.join(thumbDir, firstRel);
    return reply.sendFile(path.basename(resolved), path.dirname(resolved));
  });

  // List thumbnails for a pack
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id/thumbnails', async (request, reply) => {
    if (!getPack(request.params.id)) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    const imagesDir = getExtractedImagesDir(request.params.id);
    if (!fs.existsSync(imagesDir)) return [];
    // Load blurhashes from DB
    const blurhashMap = getPackBlurhashes(request.params.id);

    const thumbFiles = [...buildJpegOutputPaths(walkDirForExt(imagesDir, null))];

    // Sort by path, segment by segment, with numeric awareness
    thumbFiles.sort(([, a], [, b]) => {
      const aParts = a.split(/[/\\]/);
      const bParts = b.split(/[/\\]/);
      for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
        const cmp = aParts[i].localeCompare(bParts[i], undefined, { numeric: true });
        if (cmp !== 0) return cmp;
      }
      return aParts.length - bParts.length;
    });

    return thumbFiles.map(([originalFile, relPath]) => {
      const bh = blurhashMap[relPath];
      return {
        name: isUgoira(originalFile) ? originalFile : relPath,
        thumbUrl: `/api/packs/${request.params.id}/thumbnails/${encodeRelativePathForUrl(relPath)}`,
        imageUrl: `/api/packs/${request.params.id}/images/${encodeRelativePathForUrl(originalFile)}`,
        ...(isUgoira(originalFile) ? { mediaType: 'ugoira', ugoiraUrl: `/api/packs/${request.params.id}/ugoira/${encodeRelativePathForUrl(originalFile)}` } : {}),
        blurhash: bh?.hash ?? null,
        width: bh?.width ?? null,
        height: bh?.height ?? null,
      };
    });
  });

  // Get file tree for a pack
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id/file-tree', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }

    const imagesDir = getExtractedImagesDir(request.params.id);
    const videosDir = getExtractedVideosDir(request.params.id);
    const thumbDir = getThumbnailsDir(request.params.id);

    const imageFiles = fs.existsSync(imagesDir) ? walkDirWithSize(imagesDir) : [];
    const videoFiles = fs.existsSync(videosDir) ? walkDirWithSize(videosDir) : [];
    const thumbnailDir = fs.existsSync(thumbDir) ? thumbDir : null;

    return buildFileTree(request.params.id, imageFiles, videoFiles, thumbnailDir);
  });

};

function walkDirForExt(dir: string, ext: string | null): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = walkDirForExt(fullPath, ext);
      for (const c of child) {
        results.push(path.join(entry.name, c));
      }
    } else if (entry.isFile()) {
      if (ext === null || path.extname(entry.name).toLowerCase() === ext) {
        results.push(entry.name);
      }
    }
  }
  return results;
}

function walkDirWithSize(dir: string): { relPath: string; size: number }[] {
  const results: { relPath: string; size: number }[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = walkDirWithSize(fullPath);
      for (const c of child) {
        results.push({ relPath: path.join(entry.name, c.relPath), size: c.size });
      }
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      results.push({ relPath: entry.name, size: stat.size });
    }
  }
  return results;
}

function buildFileTree(
  packId: string,
  imageFiles: { relPath: string; size: number }[],
  videoFiles: { relPath: string; size: number }[],
  thumbnailDir: string | null
): import('../types.js').FileTreeNode[] {
  type NodeMap = Map<string, import('../types.js').FileTreeNode>;
  const rootChildren: NodeMap = new Map();
  const allNodes: Map<string, NodeMap> = new Map();
  allNodes.set('', rootChildren);
  const thumbnailPaths = buildJpegOutputPaths(
    imageFiles.map(file => file.relPath.split(path.sep).join('/'))
  );

  // Ensure all ancestor folders exist
  function ensureFolder(folderPath: string): NodeMap {
    if (allNodes.has(folderPath)) return allNodes.get(folderPath)!;
    const children: NodeMap = new Map();
    allNodes.set(folderPath, children);

    const parentPath = folderPath.includes('/') ? folderPath.substring(0, folderPath.lastIndexOf('/')) : '';
    const name = folderPath.includes('/') ? folderPath.substring(folderPath.lastIndexOf('/') + 1) : folderPath;
    const parent = ensureFolder(parentPath);

    if (!parent.has(name)) {
      parent.set(name, {
        name,
        type: 'folder',
        path: folderPath,
        children: [],
      });
    }
    // Update children reference
    const node = parent.get(name)!;
    node.children = Array.from(children.values());
    return children;
  }

  // Add image files
  for (const { relPath, size } of imageFiles) {
    const normalized = relPath.split(path.sep).join('/');
    const parts = normalized.split('/');
    const name = parts[parts.length - 1];
    const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

    ensureFolder(folderPath);

    const legacyThumbPath = normalized.replace(/\.[^.]+$/, '.jpg');
    const collisionSafeThumbPath = thumbnailPaths.get(normalized) ?? legacyThumbPath;
    const thumbPath = collisionSafeThumbPath;
    const thumbUrl = thumbnailDir
      ? `/api/packs/${packId}/thumbnails/${encodeRelativePathForUrl(thumbPath)}`
      : undefined;
    const imageUrl = `/api/packs/${packId}/images/${encodeRelativePathForUrl(normalized)}`;

    const folder = allNodes.get(folderPath)!;
    folder.set(name, {
      name,
      type: 'image',
      path: normalized,
      size,
      thumbUrl,
      imageUrl,
      ...(isUgoira(normalized) ? { mediaType: 'ugoira' as const } : {}),
    });
  }

  // Add video files
  for (const { relPath, size } of videoFiles) {
    const normalized = relPath.split(path.sep).join('/');
    const parts = normalized.split('/');
    const name = parts[parts.length - 1];
    const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

    ensureFolder(folderPath);

    const folder = allNodes.get(folderPath)!;
    folder.set(name, {
      name,
      type: 'video',
      videoUrl: `/api/packs/${packId}/videos/${encodeRelativePathForUrl(normalized)}`,
      path: normalized,
      size,
    });
  }

  // Rebuild children arrays from maps (folders that were created before their files were added)
  for (const [folderPath, children] of allNodes) {
    const sortedChildren = Array.from(children.values()).sort((a, b) => {
      // Folders first, then files; within each group, sort by name with numeric awareness
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    if (folderPath === '') continue;
    const parts = folderPath.split('/');
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const folderName = parts[parts.length - 1];
    const parent = allNodes.get(parentPath);
    if (parent?.has(folderName)) {
      parent.get(folderName)!.children = sortedChildren;
    }
  }

  // Compute folder sizes (sum of all descendant file sizes)
  function computeFolderSize(node: import('../types.js').FileTreeNode): number {
    if (node.type !== 'folder') return node.size ?? 0;
    let total = 0;
    for (const child of node.children ?? []) {
      total += computeFolderSize(child);
    }
    node.size = total;
    return total;
  }

  const result = Array.from(rootChildren.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  for (const node of result) computeFolderSize(node);

  return result;
}
