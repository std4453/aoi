import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { resolveWithin, validateIdentifier } from './safe-path.js';

type DiskSpaceResult = { diskPath: string; free: number; size: number };

// check-disk-space has ESM/CJS interop issues with Node16 resolution.
// Use dynamic import and cache the result.
let _checkDiskSpace: ((path: string) => Promise<DiskSpaceResult>) | null = null;
async function checkDiskSpace(directoryPath: string): Promise<DiskSpaceResult> {
  if (!_checkDiskSpace) {
    const mod = await import('check-disk-space');
    const fn = mod.default ?? mod;
    _checkDiskSpace = typeof fn === 'function' ? fn : fn.default;
  }
  return _checkDiskSpace(directoryPath);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function getPath(type: 'archive' | 'extracted' | 'generated' | 'thumbnails' | 'uploads', packId: string): string {
  const directory = type === 'archive' ? 'archives' : type;
  return resolveWithin(config.dirs[directory], validateIdentifier(packId, 'pack id'), 'pack id');
}

export function getArchivePath(packId: string, filename: string): string {
  return resolveWithin(getPath('archive', packId), filename, 'archive filename');
}

export function getExtractedImagesDir(packId: string): string {
  return resolveWithin(getPath('extracted', packId), 'images');
}

export function getExtractedVideosDir(packId: string): string {
  return resolveWithin(getPath('extracted', packId), 'videos');
}

export function getThumbnailsDir(packId: string): string {
  return resolveWithin(getPath('extracted', packId), 'thumbnails');
}

export function getGeneratedPath(packId: string): string {
  return resolveWithin(getGeneratedDir(packId), 'compressed.zip');
}

export function getGeneratedDir(packId: string): string {
  return getPath('generated', packId);
}

export function getUploadPath(uploadId: string): string {
  return resolveWithin(config.dirs.uploads, validateIdentifier(uploadId, 'upload id'), 'upload id');
}

export function getFolderStagingDir(packId: string): string {
  return resolveWithin(getPath('extracted', packId), '_staging');
}

export async function getDiskSpace(): Promise<{ free: number; size: number; used: number }> {
  const space = await checkDiskSpace(config.dataDir);
  return {
    free: space.free,
    size: space.size,
    used: space.size - space.free,
  };
}

export function removePackFiles(packId: string): void {
  const dirs = [
    getPath('archive', packId),
    getPath('extracted', packId),
    getPath('generated', packId),
    getPath('thumbnails', packId),
  ];
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function cleanupTempFiles(): Promise<number> {
  let cleaned = 0;
  // Clean orphaned uploads that have no pack_id after 24 hours
  // This is a simple cleanup; extend as needed
  return cleaned;
}

const dataSizeCacheTtl = 5 * 60 * 1_000;
const dataSizeRetryDelay = 30 * 1_000;
let cachedDataSize: number | undefined;
let dataSizeRefreshAt = 0;
let dataSizeRefresh: Promise<number> | undefined;

export async function getTotalDataSize(): Promise<number> {
  if (cachedDataSize !== undefined && Date.now() < dataSizeRefreshAt) {
    return cachedDataSize;
  }

  // Share the initial scan and background refresh across all callers.
  if (!dataSizeRefresh) {
    dataSizeRefresh = calculateTotalDataSize()
      .then(size => {
        cachedDataSize = size;
        dataSizeRefreshAt = Date.now() + dataSizeCacheTtl;
        return size;
      })
      .catch(error => {
        if (cachedDataSize === undefined) throw error;
        // Keep the last successful result and avoid retrying on every request.
        dataSizeRefreshAt = Date.now() + dataSizeRetryDelay;
        console.warn('[storage] Failed to refresh data size:', error);
        return cachedDataSize;
      })
      .finally(() => {
        dataSizeRefresh = undefined;
      });
  }

  // Only the first request after startup needs to wait for a full scan.
  return cachedDataSize ?? dataSizeRefresh;
}

async function calculateTotalDataSize(): Promise<number> {
  const sizes: number[] = [];
  for (const dir of Object.values(config.dirs)) {
    try {
      const stat = await fs.promises.stat(dir);
      if (stat.isDirectory()) {
        const du = await dirSize(dir);
        sizes.push(du);
      }
    } catch (error) {
      // Missing directories are normal; other failures must not poison the cache.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return sizes.reduce((a, b) => a + b, 0);
}

async function dirSize(dir: string): Promise<number> {
  let size = 0;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += await dirSize(full);
    } else {
      const stat = await fs.promises.stat(full);
      size += stat.size;
    }
  }
  return size;
}
