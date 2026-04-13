import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import iconv from 'iconv-lite';
import type { Pack } from '../types.js';
import {
  getArchivePath,
  ensureDir,
  getExtractedImagesDir,
  getExtractedVideosDir,
} from './storage.js';
import {
  getFileCategory,
  moveFilesFromTemp,
  type ExtractStats,
} from './file-classifier.js';

/**
 * Decode a ZIP entry filename buffer.
 * ZIP files created on non-UTF-8 systems (e.g. GBK on Chinese Windows)
 * have the UTF-8 flag bit unset. We try UTF-8 first; if it contains
 * replacement characters (U+FFFD), fall back to GBK.
 */
function decodeEntryFileName(fileNameBuffer: Buffer, isUTF8: boolean): string {
  if (isUTF8) {
    return fileNameBuffer.toString('utf8');
  }
  // Try UTF-8 first — some ZIPs don't set the flag but are still UTF-8
  const utf8Str = fileNameBuffer.toString('utf8');
  if (!utf8Str.includes('\uFFFD')) {
    return utf8Str;
  }
  // Fall back to GBK (covers GB2312/GBK/GB18030)
  return iconv.decode(fileNameBuffer, 'gbk');
}

function isSkippedEntry(entryName: string): boolean {
  // macOS resource fork files (._xxx) and __MACOSX directories
  return path.basename(entryName).startsWith('._') || entryName.includes('__MACOSX');
}

function getArchiveFileCategory(filename: string): 'image' | 'video' | 'skip' {
  if (isSkippedEntry(filename)) return 'skip';
  return getFileCategory(filename);
}

// Check if 7z is available
let _7zChecked = false;
let _7zAvailable = false;
function is7zAvailable(): boolean {
  if (_7zChecked) return _7zAvailable;
  try {
    execFileSync('which', ['7z'], { stdio: 'pipe' });
    _7zAvailable = true;
  } catch {
    _7zAvailable = false;
  }
  _7zChecked = true;
  return _7zAvailable;
}

// Extract using 7z — supports ZIP, RAR, 7z with password
function extract7z(archivePath: string, imagesDir: string, videosDir: string, password?: string): Promise<ExtractStats> {
  return new Promise((resolve, reject) => {
    const tempDir = path.join(path.dirname(imagesDir), '_temp_extract');
    ensureDir(tempDir);

    const args = ['x', '-y', '-o' + tempDir + '/'];
    if (password) {
      args.push(`-p${password}`);
    }
    args.push(archivePath);

    execFile('7z', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        const msg = stderr || stdout || err.message;
        fs.rmSync(tempDir, { recursive: true, force: true });
        if (msg.includes('Wrong password') || (password && !err.code)) {
          return reject(new Error('密码错误或压缩包已损坏'));
        }
        return reject(new Error(`7z 解压失败: ${msg}`));
      }

      try {
        const stats = moveFilesFromTemp(tempDir, imagesDir, videosDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve(stats);
      } catch (e) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        reject(e);
      }
    });
  });
}

// Extract ZIP using yauzl — extract to temp dir first, then apply structure detection
function extractZip(archivePath: string, imagesDir: string, videosDir: string): Promise<ExtractStats> {
  const tempDir = path.join(path.dirname(imagesDir), '_temp_extract');

  return new Promise((resolve, reject) => {
    ensureDir(tempDir);

    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: false }, (err, zipfile) => {
      if (err) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return reject(err);
      }
      if (!zipfile) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return reject(new Error('Failed to open ZIP'));
      }

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        // Decode filename with proper encoding detection
        const isUTF8 = (entry.flags & 0x800) !== 0;
        const fileName = decodeEntryFileName(entry.fileName as unknown as Buffer, isUTF8);

        // Skip __MACOSX directories and their contents
        if (fileName.includes('__MACOSX')) {
          zipfile.readEntry();
          return;
        }

        if (/\/$/.test(fileName)) {
          zipfile.readEntry();
          return;
        }

        const basename = path.basename(fileName);
        const category = getArchiveFileCategory(basename);

        if (category === 'skip') {
          zipfile.readEntry();
          return;
        }

        // Extract to temp dir preserving original path structure
        const outputPath = path.join(tempDir, fileName);
        ensureDir(path.dirname(outputPath));

        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) {
            console.error(`Failed to read ${fileName}: ${err.message}`);
            zipfile.readEntry();
            return;
          }

          const writeStream = fs.createWriteStream(outputPath);

          writeStream.on('finish', () => {
            zipfile.readEntry();
          });

          writeStream.on('error', (err) => {
            console.error(`Failed to write ${basename}: ${err.message}`);
            zipfile.readEntry();
          });

          pipeline(readStream, writeStream).catch((err) => {
            console.error(`Pipeline error for ${basename}: ${err.message}`);
            zipfile.readEntry();
          });
        });
      });

      zipfile.on('end', () => {
        try {
          const stats = moveFilesFromTemp(tempDir, imagesDir, videosDir);
          fs.rmSync(tempDir, { recursive: true, force: true });
          resolve(stats);
        } catch (e) {
          fs.rmSync(tempDir, { recursive: true, force: true });
          reject(e);
        }
      });

      zipfile.on('error', (err) => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        reject(err);
      });
    });
  });
}

export const archiveExtractor = {
  async extract(pack: Pack, password?: string): Promise<void> {
    const archivePath = getArchivePath(pack.id, `original.${pack.originalFormat}`);
    const imagesDir = getExtractedImagesDir(pack.id);
    const videosDir = getExtractedVideosDir(pack.id);

    let result;

    if (password) {
      if (!is7zAvailable()) {
        throw new Error('需要安装 p7zip-full 才能解压密码保护的压缩包。请运行: sudo apt-get install -y p7zip-full');
      }
      result = await extract7z(archivePath, imagesDir, videosDir, password);
    } else if (pack.originalFormat === 'zip') {
      try {
        result = await extractZip(archivePath, imagesDir, videosDir);
      } catch {
        if (!is7zAvailable()) {
          throw new Error('需要安装 p7zip-full 才能解压此压缩包。请运行: sudo apt-get install -y p7zip-full');
        }
        console.error(`yauzl failed for ${pack.name}, falling back to 7z`);
        result = await extract7z(archivePath, imagesDir, videosDir);
      }
    } else {
      if (!is7zAvailable()) {
        throw new Error('需要安装 p7zip-full 才能解压 RAR/7z 格式。请运行: sudo apt-get install -y p7zip-full');
      }
      result = await extract7z(archivePath, imagesDir, videosDir);
    }

    const { updatePackStats } = await import('../db/repositories.js');
    updatePackStats(pack.id, {
      imageCount: result.imageCount,
      videoCount: result.videoCount,
      totalImagesSize: result.totalImagesSize,
      totalVideosSize: result.totalVideosSize,
    });
  },
};
