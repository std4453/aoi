import { randomUUID } from 'node:crypto';
import { getDb } from './connection';
import { isRemoteSource, taskErrorCategories } from '../../../shared/task-errors';
import type { CreateUploadTaskRequest, UploadTask } from '~/types';

export type UploadTaskMetadata = Omit<CreateUploadTaskRequest, 'source' | 'name' | 'filename' | 'fileSize'>;

/** Older JSON rows gain derived fields without changing their persisted source. */
function readTask(json: string): UploadTask {
  const task = JSON.parse(json) as UploadTask;
  const errorCode = task.errorCode ?? null;
  return { ...task, isRemote: isRemoteSource(task.source), errorCode,
    errorCategory: errorCode ? taskErrorCategories[errorCode] : null };
}

export function getUploadTask(id: string): UploadTask | undefined {
  const row = getDb().prepare('SELECT task FROM upload_tasks WHERE id = ?').get(id) as { task: string } | undefined;
  return row ? readTask(row.task) : undefined;
}

export function listUploadTasks(): UploadTask[] {
  return (getDb().prepare('SELECT task FROM upload_tasks ORDER BY rowid DESC').all() as { task: string }[])
    .map(row => readTask(row.task));
}

export function createUploadTask(input: CreateUploadTaskRequest): UploadTask {
  const now = new Date().toISOString();
  const task: UploadTask = {
    id: randomUUID(), source: input.source, isRemote: isRemoteSource(input.source), name: input.name, filename: input.filename ?? input.name,
    totalBytes: input.fileSize ?? 0, transferredBytes: 0, progress: 0,
    status: isRemoteSource(input.source) ? 'downloading' : 'uploading', packId: null, uploadId: null,
    matches: [], error: null, errorCode: null, errorCategory: null, createdAt: now, updatedAt: now,
  };
  const metadata: UploadTaskMetadata = {
    autoName: input.autoName, url: input.url, tagIds: input.tagIds, sharePassword: input.sharePassword, archivePassword: input.archivePassword,
  };
  getDb().prepare('INSERT INTO upload_tasks (id, task, metadata) VALUES (?, ?, ?)')
    .run(task.id, JSON.stringify(task), JSON.stringify(metadata));
  return task;
}

export function updateUploadTask(id: string, patch: Partial<UploadTask>): UploadTask | undefined {
  const task = getUploadTask(id);
  if (!task) return undefined;
  const errorCode = patch.error === null || (patch.status && !['failed', 'password', 'needs_file'].includes(patch.status))
    ? null : patch.errorCode !== undefined ? patch.errorCode : task.errorCode;
  const updated = { ...task, ...patch, isRemote: isRemoteSource(task.source), errorCode, errorCategory: errorCode ? taskErrorCategories[errorCode] : null, id, createdAt: task.createdAt, updatedAt: new Date().toISOString() };
  getDb().prepare('UPDATE upload_tasks SET task = ? WHERE id = ?').run(JSON.stringify(updated), id);
  return updated;
}

export function getUploadTaskMetadata(id: string): UploadTaskMetadata {
  const row = getDb().prepare('SELECT metadata FROM upload_tasks WHERE id = ?').get(id) as { metadata: string } | undefined;
  return row ? JSON.parse(row.metadata) as UploadTaskMetadata : {};
}

export function updateUploadTaskMetadata(id: string, patch: Partial<UploadTaskMetadata>): void {
  getDb().prepare('UPDATE upload_tasks SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ ...getUploadTaskMetadata(id), ...patch }), id);
}

export function deleteUploadTask(id: string): void {
  getDb().prepare('DELETE FROM upload_tasks WHERE id = ?').run(id);
}
