import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import iconv from 'iconv-lite';
import type { Pack } from '~/types';
import {
  getArchivePath,
  ensureDir,
  getExtractedImagesDir,
  getExtractedVideosDir,
  getPath,
} from './storage';
import {
  getFileCategory,
  moveFilesFromTemp,
  type ExtractStats,
} from './file-classifier';
import { config } from '~/config';
import { normalizeRelativePath, resolveWithin } from './safe-path';
import { isArchivePasswordError } from './archive-errors';

class ArchiveSafetyError extends Error {
  override name = 'ArchiveSafetyError';
}

class ArchivePasswordRequiredError extends Error {
  constructor() {
    super('此 ZIP 压缩包需要密码，请在上传任务中填写密码后继续');
  }
}

const activeArchiveProcesses = new Set<ChildProcess>();

function trackArchiveProcess(child: ChildProcess): void {
  activeArchiveProcesses.add(child);
  child.once('exit', () => activeArchiveProcesses.delete(child));
}

async function waitForProcesses(
  processes: ChildProcess[],
  timeoutMs: number
): Promise<boolean> {
  if (processes.every(child => child.exitCode !== null || child.signalCode !== null)) {
    return true;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = Promise.all(processes.map(child => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>(resolve => child.once('exit', () => resolve()));
  })).then(() => true);
  const timedOut = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function terminateArchiveProcesses(timeoutMs = 2_000): Promise<void> {
  const processes = [...activeArchiveProcesses];
  if (processes.length === 0) return;

  for (const child of processes) child.kill('SIGTERM');
  if (await waitForProcesses(processes, timeoutMs)) return;

  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await waitForProcesses(processes, 500);
}

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

function prepareTempDir(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
  ensureDir(tempDir);
}

function getExtractionBudget(tempDir: string): number {
  const stats = fs.statfsSync(tempDir);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const reserve = Math.min(128 * 1024 * 1024, Math.floor(freeBytes * 0.1));
  return Math.min(config.maxExtractedSize, Math.max(0, freeBytes - reserve));
}

function safe7zMessage(stdout: string, stderr: string, password?: string): string {
  let message = `${stderr}\n${stdout}`.trim() || '7z command failed or timed out';
  if (password) {
    message = message.split(password).join('[redacted]');
  }
  return message.slice(-4_000);
}

function measureExtractedTree(dir: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ArchiveSafetyError('Archive contains a symbolic link');
    }
    if (entry.isDirectory()) {
      const child = measureExtractedTree(fullPath);
      entries += child.entries;
      bytes += child.bytes;
    } else if (entry.isFile()) {
      entries++;
      bytes += fs.statSync(fullPath).size;
    }
    if (entries > config.maxArchiveEntries || bytes > config.maxExtractedSize) {
      throw new ArchiveSafetyError('Extracted archive exceeds the configured resource limits');
    }
  }
  return { entries, bytes };
}

// Check if 7z is available
let _7zChecked = false;
let _7zAvailable = false;
function is7zAvailable(): boolean {
  if (_7zChecked) return _7zAvailable;
  try {
    execFileSync('7z', ['i'], { stdio: 'ignore', timeout: 5_000 });
    _7zAvailable = true;
  } catch {
    _7zAvailable = false;
  }
  _7zChecked = true;
  return _7zAvailable;
}

function inspect7zArchive(
  archivePath: string,
  extractionBudget: number,
  password?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['l', '-slt', '-ba'];
    if (password) args.push(`-p${password}`);
    args.push(archivePath);

    const child = execFile('7z', args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: config.archiveCommandTimeout,
    }, (err, stdout, stderr) => {
      if (err) {
        if (isArchivePasswordError(`${stderr}\n${stdout}`)) {
          reject(new Error(password
            ? '密码错误或压缩包已损坏'
            : '此压缩包需要密码，请在上传任务中填写密码后继续'));
          return;
        }
        reject(new Error(`无法检查压缩包内容: ${safe7zMessage(stdout, stderr, password)}`));
        return;
      }

      let entries = 0;
      let totalSize = 0;
      const listedPaths = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith('Path = ')) {
          const listedPath = line.slice('Path = '.length).replace(/[\\/]+$/, '');
          if (listedPath && listedPath !== '.') {
            try {
              const normalized = normalizeRelativePath(listedPath, 'archive entry path');
              if (listedPaths.has(normalized)) {
                reject(new ArchiveSafetyError('Archive contains duplicate entry paths'));
                return;
              }
              listedPaths.add(normalized);
            } catch (error) {
              reject(new ArchiveSafetyError(
                error instanceof Error ? error.message : String(error)
              ));
              return;
            }
          }
          entries++;
        }
        if (is7zLinkField(line)) {
          reject(new ArchiveSafetyError('Archive contains a symbolic link'));
          return;
        }
        if (line.startsWith('Size = ')) {
          const size = Number(line.slice('Size = '.length));
          if (Number.isFinite(size) && size > 0) totalSize += size;
        }
      }

      const archiveSize = fs.statSync(archivePath).size;
      if (
        entries > config.maxArchiveEntries ||
        totalSize > extractionBudget ||
        (archiveSize > 0 && totalSize / archiveSize > config.maxCompressionRatio)
      ) {
        reject(new ArchiveSafetyError('压缩包超过允许的文件数量、解压大小或压缩比限制'));
        return;
      }
      resolve();
    });
    trackArchiveProcess(child);
    // Background jobs must not wait for an interactive password prompt.
    child.stdin?.end();
  });
}

/** Modern 7-Zip prints empty link fields for ordinary RAR entries too. */
export function is7zLinkField(line: string): boolean {
  return /^(?:Symbolic|Hard|Copy) Link =\s*\S/.test(line)
    || /^Attributes = (?:.*\s)?l[rwxstST-]{9}(?:\s|$)/.test(line);
}

// Extract using 7z — supports ZIP, RAR, 7z with password
async function extract7z(archivePath: string, imagesDir: string, videosDir: string, password?: string): Promise<ExtractStats> {
  const tempDir = path.join(path.dirname(imagesDir), '_temp_extract');
  prepareTempDir(tempDir);
  try {
    await inspect7zArchive(archivePath, getExtractionBudget(tempDir), password);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }

  return new Promise((resolve, reject) => {
    const args = ['x', '-y', '-o' + tempDir + '/'];
    if (password) {
      args.push(`-p${password}`);
    }
    args.push(archivePath);

    const child = execFile('7z', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: config.archiveCommandTimeout,
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        const msg = safe7zMessage(stdout, stderr, password);
        fs.rmSync(tempDir, { recursive: true, force: true });
        if (isArchivePasswordError(`${stderr}\n${stdout}`)) {
          return reject(new Error(password
            ? '密码错误或压缩包已损坏'
            : '此压缩包需要密码，请在上传任务中填写密码后继续'));
        }
        return reject(new Error(`7z 解压失败: ${msg}`));
      }

      try {
        measureExtractedTree(tempDir);
        const stats = moveFilesFromTemp(tempDir, imagesDir, videosDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve(stats);
      } catch (e) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        reject(e);
      }
    });
    trackArchiveProcess(child);
    child.stdin?.end();
  });
}

// Extract ZIP using yauzl — extract to temp dir first, then apply structure detection
function extractZip(archivePath: string, imagesDir: string, videosDir: string): Promise<ExtractStats> {
  const tempDir = path.join(path.dirname(imagesDir), '_temp_extract');

  return new Promise((resolve, reject) => {
    prepareTempDir(tempDir);
    const extractionBudget = getExtractionBudget(tempDir);
    let entryCount = 0;
    let totalUncompressedSize = 0;
    let settled = false;

    const fail = (zipfile: yauzl.ZipFile | undefined, error: unknown) => {
      if (settled) return;
      settled = true;
      try {
        zipfile?.close();
      } catch {
        // Ignore close errors while preserving the original failure.
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    yauzl.open(archivePath, {
      lazyEntries: true,
      decodeStrings: false,
      validateEntrySizes: true,
    }, (err, zipfile) => {
      if (err) {
        fail(zipfile, err);
        return;
      }
      if (!zipfile) {
        fail(zipfile, new Error('Failed to open ZIP'));
        return;
      }

      zipfile.on('entry', (entry) => {
        if (settled) return;
        try {
          if (entry.isEncrypted()) throw new ArchivePasswordRequiredError();
          entryCount++;
          totalUncompressedSize += entry.uncompressedSize;
          if (
            entryCount > config.maxArchiveEntries ||
            totalUncompressedSize > extractionBudget
          ) {
            throw new ArchiveSafetyError('ZIP exceeds the configured extraction limits');
          }
          if (
            entry.uncompressedSize > 0 &&
            (entry.compressedSize === 0 ||
              entry.uncompressedSize / entry.compressedSize > config.maxCompressionRatio)
          ) {
            throw new ArchiveSafetyError('ZIP entry exceeds the configured compression ratio');
          }

          const isUTF8 = (entry.generalPurposeBitFlag & 0x800) !== 0;
          const decodedName = decodeEntryFileName(entry.fileName as unknown as Buffer, isUTF8);
          const isDirectory = /\/$/.test(decodedName);
          let fileName: string;
          try {
            fileName = normalizeRelativePath(
              isDirectory ? decodedName.replace(/\/+$/, '') : decodedName,
              'ZIP entry path'
            );
          } catch (error) {
            throw new ArchiveSafetyError(
              error instanceof Error ? error.message : String(error)
            );
          }

          if (fileName.split('/').includes('__MACOSX') || isDirectory) {
            zipfile.readEntry();
            return;
          }

          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((unixMode & 0o170000) === 0o120000) {
            throw new ArchiveSafetyError('ZIP contains a symbolic link');
          }

          const basename = path.posix.basename(fileName);
          const category = getArchiveFileCategory(basename);

          if (category === 'skip') {
            zipfile.readEntry();
            return;
          }

          const outputPath = resolveWithin(tempDir, fileName, 'ZIP entry path');
          ensureDir(path.dirname(outputPath));

          zipfile.openReadStream(entry, (streamError, readStream) => {
            if (streamError || !readStream) {
              fail(zipfile, streamError ?? new Error(`Failed to read ${fileName}`));
              return;
            }

            void pipeline(readStream, fs.createWriteStream(outputPath, { flags: 'wx' }))
              .then(() => {
                if (!settled) zipfile.readEntry();
              })
              .catch(error => {
                const nodeError = error as NodeJS.ErrnoException;
                fail(
                  zipfile,
                  nodeError.code === 'EEXIST'
                    ? new ArchiveSafetyError('ZIP contains duplicate file paths')
                    : error
                );
              });
          });
        } catch (error) {
          fail(zipfile, error);
        }
      });

      zipfile.on('end', () => {
        if (settled) return;
        try {
          const stats = moveFilesFromTemp(tempDir, imagesDir, videosDir);
          fs.rmSync(tempDir, { recursive: true, force: true });
          settled = true;
          resolve(stats);
        } catch (e) {
          fail(zipfile, e);
        }
      });

      zipfile.on('error', error => fail(zipfile, error));
      zipfile.readEntry();
    });
  });
}

export const archiveExtractor = {
  async extract(pack: Pack, password?: string): Promise<void> {
    const archivePath = getArchivePath(pack.id, `original.${pack.originalFormat}`);
    const imagesDir = getExtractedImagesDir(pack.id);
    const videosDir = getExtractedVideosDir(pack.id);
    const extractedRoot = getPath('extracted', pack.id);

    // Extraction is restartable: discard any partial prior attempt so a crash
    // cannot duplicate files on the next run.
    fs.rmSync(extractedRoot, { recursive: true, force: true });

    let result;

    if (password) {
      if (!is7zAvailable()) {
        throw new Error('系统中未找到 7z 命令，无法解压密码保护的压缩包');
      }
      result = await extract7z(archivePath, imagesDir, videosDir, password);
    } else if (pack.originalFormat === 'zip') {
      try {
        result = await extractZip(archivePath, imagesDir, videosDir);
      } catch (error) {
        if (error instanceof ArchiveSafetyError || error instanceof ArchivePasswordRequiredError) throw error;
        if (!is7zAvailable()) {
          throw new Error('系统中未找到 7z 命令，无法回退解压此压缩包');
        }
        console.error(`yauzl failed for ${pack.name}, falling back to 7z`);
        result = await extract7z(archivePath, imagesDir, videosDir);
      }
    } else {
      if (!is7zAvailable()) {
        throw new Error('系统中未找到 7z 命令，无法解压 RAR/7z 格式');
      }
      result = await extract7z(archivePath, imagesDir, videosDir);
    }

    const { updatePackStats } = await import('~/db/repositories');
    updatePackStats(pack.id, {
      imageCount: result.imageCount,
      videoCount: result.videoCount,
      totalImagesSize: result.totalImagesSize,
      totalVideosSize: result.totalVideosSize,
    });
  },
};
