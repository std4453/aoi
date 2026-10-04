import { randomUUID } from 'node:crypto';
import { getDb } from './connection.js';
import type { CreateUploadTaskRequest, UploadTask } from '../../../shared/types.js';

export type UploadTaskMetadata = Omit<CreateUploadTaskRequest, 'source' | 'name' | 'filename' | 'fileSize'>;

export function getUploadTask(id: string): UploadTask | undefined {
  const row = getDb().prepare('SELECT task FROM upload_tasks WHERE id = ?').get(id) as { task: string } | undefined;
  return row ? JSON.parse(row.task) as UploadTask : undefined;
}

export function listUploadTasks(): UploadTask[] {
  return (getDb().prepare('SELECT task FROM upload_tasks ORDER BY rowid DESC').all() as { task: string }[])
    .map(row => JSON.parse(row.task) as UploadTask);
}

export function createUploadTask(input: CreateUploadTaskRequest): UploadTask {
  const now = new Date().toISOString();
  const task: UploadTask = {
    id: randomUUID(), source: input.source, name: input.name, filename: input.filename ?? input.name,
    totalBytes: input.fileSize ?? 0, transferredBytes: 0, progress: 0,
    status: ['mega', 'pixiv', 'fanbox'].includes(input.source) ? 'downloading' : 'uploading', packId: null, uploadId: null,
    matches: [], error: null, createdAt: now, updatedAt: now,
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
  const updated = { ...task, ...patch, id, createdAt: task.createdAt, updatedAt: new Date().toISOString() };
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
