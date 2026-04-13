import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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
  const base = config.dirs[type === 'archive' ? 'archives' : type];
  return path.join(base, packId);
}

export function getArchivePath(packId: string, filename: string): string {
  return path.join(config.dirs.archives, packId, filename);
}

export function getExtractedImagesDir(packId: string): string {
  return path.join(config.dirs.extracted, packId, 'images');
}

export function getExtractedVideosDir(packId: string): string {
  return path.join(config.dirs.extracted, packId, 'videos');
}

export function getThumbnailsDir(packId: string): string {
  return path.join(config.dirs.extracted, packId, 'thumbnails');
}

export function getGeneratedPath(packId: string): string {
  return path.join(config.dirs.generated, packId, 'compressed.zip');
}

export function getGeneratedDir(packId: string): string {
  return path.join(config.dirs.generated, packId);
}

export function getUploadPath(uploadId: string): string {
  return path.join(config.dirs.uploads, uploadId);
}

export function getFolderStagingDir(packId: string): string {
  return path.join(config.dirs.extracted, packId, '_staging');
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
    path.join(config.dirs.archives, packId),
    path.join(config.dirs.extracted, packId),
    path.join(config.dirs.generated, packId),
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

export async function getTotalDataSize(): Promise<number> {
  const sizes: number[] = [];
  for (const dir of Object.values(config.dirs)) {
    try {
      const stat = await fs.promises.stat(dir);
      if (stat.isDirectory()) {
        const du = await dirSize(dir);
        sizes.push(du);
      }
    } catch {
      // directory doesn't exist yet
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
