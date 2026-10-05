import type { Job, TaskErrorCode } from '~/types';
import { TaskError } from '~/task-errors';
import { isArchivePasswordError } from './archive-errors';

export function jobFailureCode(type: Job['type']): TaskErrorCode {
  return type === 'extract' ? 'EXTRACTION_FAILED' : type === 'verify' ? 'VERIFICATION_FAILED'
    : type === 'thumbnail' ? 'PREVIEW_FAILED' : type === 'pixiv' || type === 'fanbox' ? 'DOWNLOAD_FAILED' : 'PROCESSING_FAILED';
}

/** Translate untyped OS/third-party failures once, at the service boundary. */
export function taskErrorCode(error: unknown, fallback: TaskErrorCode): TaskErrorCode {
  if (error instanceof TaskError) return error.code;
  const value = error as { code?: string; name?: string; cause?: { code?: string } } | null;
  const code = value?.code ?? value?.cause?.code;
  if (code === 'ENOSPC') return 'STORAGE_FULL';
  if (code === 'ENOENT') return 'SOURCE_UNAVAILABLE';
  if (code && /^(?:ECONN|ENET|EHOST|ENOTFOUND|ETIMEDOUT|UND_ERR)/.test(code)) return 'NETWORK_ERROR';
  if (value?.name === 'TimeoutError') return 'NETWORK_ERROR';
  return fallback;
}

/** 7z emits text diagnostics; parse them only in the extraction adapter. */
export function archiveErrorCode(error: unknown): TaskErrorCode {
  const fallback = taskErrorCode(error, 'EXTRACTION_FAILED');
  if (fallback !== 'EXTRACTION_FAILED') return fallback;
  const message = error instanceof Error ? error.message : String(error);
  if (isArchivePasswordError(message)) return /密码错误|wrong password|incorrect password/i.test(message)
    ? 'PASSWORD_INCORRECT' : 'PASSWORD_REQUIRED';
  if (/unsupported method|不支持.*压缩方法/i.test(message)) return 'ARCHIVE_UNSUPPORTED';
  if (/not archive|as \[\w+\] archive|central directory|end of (?:file|data)|压缩包已损坏/i.test(message)) return 'ARCHIVE_INVALID';
  if (/exceeds|limit|超过|超出/i.test(message)) return 'RESOURCE_LIMIT';
  return fallback;
}
