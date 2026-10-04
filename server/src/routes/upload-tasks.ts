import { isTaskErrorCode } from '../../../shared/task-errors.js';
import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import type { CreateUploadTaskRequest, UploadTask } from '../../../shared/types.js';
import { getPack, getPackFiles, listTags, hasAnyActiveJob, deletePack, updatePackStatus } from '../db/repositories.js';
import { createUploadTask, getUploadTaskMetadata, updateUploadTaskMetadata, updateUploadTask,
  getSyncedUploadTask, listSyncedUploadTasks, deleteUploadTask, retryPackTask, createPostUploadTask } from '../services/upload-tasks.js';
import { continueFolderVerification } from '../services/content-verification.js';
import { getUploadPath, removePackFiles } from '../services/storage.js';
import { jobQueue } from '../services/job-queue.js';
import { config } from '../config/index.js';
import { withUploadLock } from '../services/archive-deduplication.js';
import { validateMegaUrl } from '../services/mega-link.js';
import { parseFanboxUrl } from '../services/fanbox-client.js';
import { parsePixivUrl } from '../services/pixiv-importer.js';

function password(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 1_024) throw new Error('密码长度不能超过 1024 个字符');
  return value;
}

function validateCreate(input: CreateUploadTaskRequest): CreateUploadTaskRequest {
  if (!input || !['archive', 'folder', 'mega', 'pixiv', 'fanbox'].includes(input.source)) throw new Error('Invalid source');
  if (input.autoName !== undefined && typeof input.autoName !== 'boolean') throw new Error('Invalid autoName');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || /[\0\r\n]/.test(input.name)) throw new Error('Invalid name');
  if (input.filename !== undefined && (typeof input.filename !== 'string' || input.filename.length > 255 || /[\0\r\n\\/]/.test(input.filename))) throw new Error('Invalid filename');
  if (input.fileSize !== undefined && (!Number.isSafeInteger(input.fileSize) || input.fileSize < 0 || input.fileSize > config.maxExtractedSize)) throw new Error('Invalid file size');
  if (input.tagIds !== undefined && (!Array.isArray(input.tagIds) || input.tagIds.length > 1_000 || input.tagIds.some(id => typeof id !== 'string' || !listTags().some(tag => tag.id === id)))) throw new Error('Invalid tags');
  if (input.source === 'mega') {
    validateMegaUrl(input.url!);
  }
  if (input.source === 'pixiv' || input.source === 'fanbox') {
    if (typeof input.url !== 'string' || input.url.length > 2048) throw new Error('Invalid post URL');
    (input.source === 'fanbox' ? parseFanboxUrl : parsePixivUrl)(input.url);
  }
  password(input.archivePassword);
  password(input.sharePassword);
  return { ...input, name: input.name.trim() };
}

export const registerUploadTaskRoutes: FastifyPluginAsync = async fastify => {
  fastify.get('/api/upload-tasks', async () => listSyncedUploadTasks());
  fastify.get<{ Params: { id: string } }>('/api/upload-tasks/:id', async (request, reply) => {
    const task = getSyncedUploadTask(request.params.id);
    return task ?? reply.code(404).send({ error: 'Upload task not found' });
  });
  fastify.post<{ Body: CreateUploadTaskRequest }>('/api/upload-tasks', async (request, reply) => {
    try {
      const input = validateCreate(request.body);
      const task = ['pixiv', 'fanbox'].includes(input.source) ? createPostUploadTask(input) : createUploadTask(input);
      if (task.source === 'mega') {
        const { startMegaImport } = await import('../services/mega-import.js');
        void startMegaImport(task.id, { ...getUploadTaskMetadata(task.id), name: task.name });
      }
      return task;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  fastify.patch<{ Params: { id: string }; Body: { uploadId?: string; packId?: string; progress?: number; transferredBytes?: number; status?: UploadTask['status']; error?: string | null; errorCode?: UploadTask['errorCode'] } }>('/api/upload-tasks/:id', async (request, reply) => {
    const task = getSyncedUploadTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Upload task not found' });
    try {
      if (task.isRemote || ['completed', 'processing', 'duplicate', 'password'].includes(task.status)) throw new Error('Task is controlled by the server');
      const input = request.body ?? {};
      const patch: Partial<UploadTask> = {};
      if (input.uploadId !== undefined) {
        getUploadPath(input.uploadId);
        if (task.packId && task.source === 'archive') throw new Error('Archive is already submitted');
        patch.uploadId = input.uploadId;
      }
      if (input.packId !== undefined) {
        const pack = getPack(input.packId);
        if (!pack || pack.sourceType !== task.source || (task.packId && task.packId !== pack.id)) throw new Error('Invalid pack');
        if (listSyncedUploadTasks().some(other => other.id !== task.id && other.packId === pack.id)) throw new Error('Pack belongs to another task');
        patch.packId = pack.id;
      }
      if (input.status !== undefined) {
        if (!['uploading', 'paused', 'needs_file', 'failed'].includes(input.status)) throw new Error('Invalid client task state');
        patch.status = input.status;
      }
      if (input.progress !== undefined) {
        if (!Number.isFinite(input.progress) || input.progress < 0 || input.progress > 100) throw new Error('Invalid progress');
        patch.progress = input.progress;
      }
      if (input.transferredBytes !== undefined) {
        if (!Number.isSafeInteger(input.transferredBytes) || input.transferredBytes < 0 || input.transferredBytes > task.totalBytes) throw new Error('Invalid transferred bytes');
        patch.transferredBytes = input.transferredBytes;
      }
      if (input.error !== undefined) {
        if (input.error !== null && (typeof input.error !== 'string' || input.error.length > 4_096)) throw new Error('Invalid error');
        patch.error = input.error;
      }
      if (input.errorCode !== undefined) {
        if (input.errorCode !== null && !isTaskErrorCode(input.errorCode)) throw new Error('Invalid error code');
        patch.errorCode = input.errorCode;
      }
      if (patch.status === 'failed' && !patch.errorCode) patch.errorCode = 'UPLOAD_FAILED';
      if (patch.status === 'uploading' && task.status === 'needs_file' && task.packId) {
        const pack = getPack(task.packId);
        if (pack?.sourceType === 'folder' && pack.status === 'failed') updatePackStatus(pack.id, 'uploading');
      }
      return updateUploadTask(task.id, patch);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  fastify.post<{ Params: { id: string }; Body: { uploadId?: string; allowDuplicate?: boolean; archivePassword?: string } }>('/api/upload-tasks/:id/complete', async (request, reply) => {
    const task = getSyncedUploadTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Upload task not found' });
    if (task.packId) return task;
    if (task.source !== 'archive') return reply.code(400).send({ error: 'Not an archive task' });
    const body = request.body ?? {};
    const metadata = getUploadTaskMetadata(task.id);
    try { password(body.archivePassword); } catch (error) { return reply.code(400).send({ error: String(error) }); }
    if (body.archivePassword !== undefined) updateUploadTaskMetadata(task.id, { archivePassword: body.archivePassword });
    const response = await fastify.inject({ method: 'POST', url: '/api/packs/upload-complete', headers: { authorization: request.headers.authorization ?? '' }, payload: {
      taskId: task.id, uploadId: body.uploadId ?? task.uploadId, filename: task.filename, fileSize: task.totalBytes,
      packName: task.name, tagIds: metadata.tagIds, archivePassword: body.archivePassword ?? metadata.archivePassword, allowDuplicate: body.allowDuplicate,
    } });
    if (response.statusCode >= 400 && response.json().code !== 'DUPLICATE_ARCHIVE') return reply.code(response.statusCode).send(response.json());
    return getSyncedUploadTask(task.id);
  });
  fastify.post<{ Params: { id: string } }>('/api/upload-tasks/:id/continue', async (request, reply) => {
    const task = getSyncedUploadTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Upload task not found' });
    if (task.status !== 'duplicate') return reply.code(409).send({ error: 'Task does not need duplicate confirmation' });
    if (task.packId) {
      continueFolderVerification(task.packId);
      jobQueue.start();
    } else if (task.source === 'mega') {
      const { continueMegaImport } = await import('../services/mega-import.js');
      void continueMegaImport(task.id);
    } else {
      const response = await fastify.inject({ method: 'POST', url: `/api/upload-tasks/${task.id}/complete`, headers: { authorization: request.headers.authorization ?? '' }, payload: { allowDuplicate: true } });
      return reply.code(response.statusCode).send(response.json());
    }
    return getSyncedUploadTask(task.id);
  });
  fastify.post<{ Params: { id: string }; Body: { archivePassword?: string; sharePassword?: string } }>('/api/upload-tasks/:id/retry', async (request, reply) => {
    const task = getSyncedUploadTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Upload task not found' });
    try {
      if (!['failed', 'password', 'needs_file', 'paused'].includes(task.status)) return reply.code(409).send({ error: 'Task cannot be retried in its current state' });
      const input = request.body ?? {};
      const patch = { ...(input.sharePassword !== undefined ? { sharePassword: password(input.sharePassword) } : {}), ...(input.archivePassword !== undefined ? { archivePassword: password(input.archivePassword) } : {}) };
      updateUploadTaskMetadata(task.id, patch);
      if (task.source === 'mega') {
        const { startMegaImport, hasPendingMegaHandoff } = await import('../services/mega-import.js');
        if (!task.packId || hasPendingMegaHandoff(task)) {
          void startMegaImport(task.id, { ...getUploadTaskMetadata(task.id), name: task.name }, Boolean(task.packId));
        } else await retryPackTask(task, input.archivePassword);
      } else if (task.packId) await retryPackTask(task, input.archivePassword);
      else updateUploadTask(task.id, { status: 'needs_file', error: null });
      return getSyncedUploadTask(task.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  fastify.delete<{ Params: { id: string } }>('/api/upload-tasks/:id', async (request, reply) => {
    return withUploadLock(`upload-task-${request.params.id}`, async () => {
      let task = getSyncedUploadTask(request.params.id);
      if (!task) return { ok: true };
      if (task.source === 'mega') {
        const { cancelMegaImport } = await import('../services/mega-import.js');
        await cancelMegaImport(task.id);
        // The worker may have materialized a pack while cancellation was queued.
        task = getSyncedUploadTask(task.id)!;
      }
      const remove = async () => {
        if (task.packId && task.status !== 'completed') {
          try { await jobQueue.cancelImport(task.packId); } catch { return reply.code(409).send({ error: '图包正在处理，请等待处理完成' }); }
          if (hasAnyActiveJob(task.packId)) return reply.code(409).send({ error: '图包正在处理，请等待处理完成' });
          for (const file of getPackFiles(task.packId)) if (file.uploadId) {
            for (const suffix of ['', '.info', '.json']) fs.rmSync(getUploadPath(file.uploadId) + suffix, { force: true });
          }
          removePackFiles(task.packId);
          deletePack(task.packId);
        }
        if (task.uploadId) for (const suffix of ['', '.info', '.json']) fs.rmSync(getUploadPath(task.uploadId) + suffix, { force: true });
        deleteUploadTask(task.id);
        return { ok: true };
      };
      return task.packId ? withUploadLock(`folder-${task.packId}`, remove) : remove();
    });
  });
};
