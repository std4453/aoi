import type { TaskErrorCategory, TaskErrorCode, UploadTaskType, RemoteTaskType } from './types.js';

/** Stable wire codes; diagnostics are never interpreted by presentation components. */
export const taskErrorCategories = {
  AUTH_REQUIRED: 'authentication', ACCESS_DENIED: 'access',
  NETWORK_ERROR: 'network', RATE_LIMITED: 'network',
  SOURCE_UNAVAILABLE: 'source', SOURCE_QUOTA: 'source', NO_SUPPORTED_MEDIA: 'source',
  SOURCE_BLOCKED: 'source', CHALLENGE_FAILED: 'source',
  STORAGE_FULL: 'storage', RESOURCE_LIMIT: 'storage',
  PASSWORD_REQUIRED: 'password', PASSWORD_INCORRECT: 'password',
  ARCHIVE_INVALID: 'extraction', ARCHIVE_UNSUPPORTED: 'extraction', EXTRACTION_FAILED: 'extraction',
  VERIFICATION_FAILED: 'verification', PREVIEW_FAILED: 'preview',
  UPLOAD_FAILED: 'upload', DOWNLOAD_FAILED: 'download', PROCESSING_FAILED: 'processing',
} as const satisfies Record<TaskErrorCode, TaskErrorCategory>;

export function isTaskErrorCode(value: unknown): value is TaskErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(taskErrorCategories, value);
}

export function isRemoteSource(source: UploadTaskType | null): source is RemoteTaskType {
  return source === 'mega' || source === 'pixiv' || source === 'fanbox';
}

export class TaskError extends Error {
  constructor(public readonly code: TaskErrorCode, message: string) { super(message); }
}
