import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './storage.js';

export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.avif', '.heic', '.heif',
]);
export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.3gp',
]);
export const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz']);

export function getFileCategory(filename: string): 'image' | 'video' | 'skip' {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'skip';
  return 'skip';
}

export function getUniqueName(dir: string, relativePath: string): string {
  const target = path.join(dir, relativePath);
  if (!fs.existsSync(target)) return relativePath;
  const ext = path.extname(relativePath);
  const base = path.basename(relativePath, ext);
  const parent = path.dirname(relativePath);
  let counter = 1;
  while (fs.existsSync(path.join(dir, parent, `${base} (${counter})${ext}`))) {
    counter++;
  }
  return path.join(parent, `${base} (${counter})${ext}`);
}

export function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export function analyzeStructure(tempDir: string): string {
  const entries = fs.readdirSync(tempDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory());
  const files = entries.filter(e => e.isFile());

  if (dirs.length === 0) {
    return tempDir;
  }

  if (dirs.length === 1 && files.length === 0) {
    const innerDir = path.join(tempDir, dirs[0].name);
    const innerEntries = fs.readdirSync(innerDir, { withFileTypes: true });
    const innerDirs = innerEntries.filter(e => e.isDirectory());

    if (innerDirs.length === 0) {
      // Single wrapper directory with only files — strip it
      return innerDir;
    }

    // Single wrapper directory but contains subdirectories — strip wrapper, keep inner structure
    return innerDir;
  }

  return tempDir;
}

export interface ExtractStats {
  imageCount: number;
  videoCount: number;
  totalImagesSize: number;
  totalVideosSize: number;
}

export function moveFilesFromTemp(tempDir: string, imagesDir: string, videosDir: string): ExtractStats {
  ensureDir(imagesDir);
  ensureDir(videosDir);

  const basePath = analyzeStructure(tempDir);
  const files = walkDir(basePath);

  let imageCount = 0;
  let videoCount = 0;
  let totalImagesSize = 0;
  let totalVideosSize = 0;

  for (const srcPath of files) {
    const filename = path.basename(srcPath);
    const category = getFileCategory(filename);
    if (category === 'skip') continue;

    const dir = category === 'image' ? imagesDir : videosDir;

    const destRelativePath = path.relative(basePath, srcPath);
    const uniquePath = getUniqueName(dir, destRelativePath);
    const dstPath = path.join(dir, uniquePath);
    ensureDir(path.dirname(dstPath));
    fs.renameSync(srcPath, dstPath);

    const stat = fs.statSync(dstPath);
    if (category === 'image') {
      imageCount++;
      totalImagesSize += stat.size;
    } else {
      videoCount++;
      totalVideosSize += stat.size;
    }
  }

  return { imageCount, videoCount, totalImagesSize, totalVideosSize };
}
