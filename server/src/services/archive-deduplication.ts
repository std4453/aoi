import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { findUnhashedArchives, setArchiveMd5 } from '../db/repositories.js';
import { getArchivePath } from './storage.js';

export async function hashArchive(filePath: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function backfillArchiveHashes(size: number): Promise<void> {
  for (const pack of findUnhashedArchives(size)) {
    try {
      const md5 = await hashArchive(getArchivePath(pack.id, `original.${pack.originalFormat}`));
      setArchiveMd5(pack.id, md5);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      console.warn(`[archive-md5] Original archive missing for pack ${pack.id}`);
    }
  }
}

const confirmations = new Map<string, Promise<unknown>>();

export async function withUploadLock<T>(uploadId: string, operation: () => Promise<T>): Promise<T> {
  const previous = confirmations.get(uploadId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  confirmations.set(uploadId, current);
  try {
    return await current;
  } finally {
    if (confirmations.get(uploadId) === current) confirmations.delete(uploadId);
  }
}
