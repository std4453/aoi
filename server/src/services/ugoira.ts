import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import yauzl from 'yauzl';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config/index.js';
import type { UgoiraManifest } from '../../../shared/types.js';

export const ugoiraFramesSchema = z.array(z.object({
  file: z.string().regex(/^[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i),
  delay: z.number().int().min(1).max(60_000),
})).min(1).max(1000).refine(frames => new Set(frames.map(frame => frame.file)).size === frames.length, 'Duplicate ugoira frames');
export const ugoiraManifestSchema = z.object({ format: z.literal('aoi-ugoira'), version: z.literal(1), frames: ugoiraFramesSchema });
export const isUgoira = (filename: string) => filename.toLowerCase().endsWith('.ugoira');
const maxFrameBytes = 32 * 1024 * 1024;
const maxUnpackedBytes = () => Math.min(config.maxExtractedSize, 512 * 1024 * 1024);

// Never extract archive paths onto the filesystem. Validate all central-directory entries,
// then read only bounded frame buffers. Also used for untrusted uploaded .ugoira bundles.
async function visitZip(filename: string, visitor: (entry: yauzl.Entry, read: () => Promise<Buffer>) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new Error('无效的 ugoira 压缩包'));
      let total = 0;
      const names = new Set<string>();
      const fail = (reason: unknown) => { zip.close(); reject(reason); };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (names.has(entry.fileName) || names.size >= 1001 || (mode && mode !== 0x8000) || entry.isEncrypted() ||
              !/^(?:manifest\.json|[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/i.test(entry.fileName)) throw new Error('不安全的 ugoira 文件');
          names.add(entry.fileName);
          total += entry.uncompressedSize;
          const limit = entry.fileName === 'manifest.json' ? 256 * 1024 : maxFrameBytes;
          if (entry.uncompressedSize > limit || total > maxUnpackedBytes() || entry.uncompressedSize / Math.max(1, entry.compressedSize) > config.maxCompressionRatio) throw new Error('ugoira 超出解压大小限制');
          await visitor(entry, () => new Promise((res, rej) => {
            zip.openReadStream(entry, (err, stream) => {
              if (err || !stream) return rej(err ?? new Error('无法读取 ugoira 帧'));
              const chunks: Buffer[] = []; let bytes = 0;
              stream.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > limit) stream.destroy(new Error('ugoira 帧过大'));
                else chunks.push(chunk);
              });
              stream.on('error', rej);
              stream.on('end', () => res(Buffer.concat(chunks)));
            });
          }));
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

export async function createUgoira(zipPath: string, destination: string, frames: UgoiraManifest['frames']): Promise<void> {
  frames = ugoiraFramesSchema.parse(frames);
  const expected = new Set(frames.map(frame => frame.file));
  const seen = new Set<string>();
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const temporary = `${destination}.part`;
  const output = fs.createWriteStream(temporary);
  const completion = pipeline(archive, output);
  // Observe errors immediately, even while an entry is being decoded.
  void completion.catch(() => {});
  try {
    const manifest: UgoiraManifest = { format: 'aoi-ugoira', version: 1, frames };
    const manifestWritten = once(archive, 'entry');
    archive.append(JSON.stringify(manifest), { name: 'manifest.json', date: new Date(0) });
    await manifestWritten;
    let width = 0; let height = 0;
    await visitZip(zipPath, async (entry, read) => {
      if (!expected.has(entry.fileName)) throw new Error('ugoira 帧列表与压缩包不匹配');
      const buffer = await read();
      const info = await sharp(buffer, { limitInputPixels: config.maxImagePixels }).metadata();
      if (!info.width || !info.height || (width && (info.width !== width || info.height !== height))) throw new Error('ugoira 帧尺寸不一致');
      width = info.width; height = info.height;
      const written = once(archive, 'entry');
      archive.append(buffer, { name: entry.fileName, date: new Date(0) });
      await written;
      seen.add(entry.fileName);
    });
    if (seen.size !== expected.size) throw new Error('ugoira 帧缺失');
    await archive.finalize();
    await completion;
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    archive.abort(); archive.destroy(); output.destroy();
    await completion.catch(() => {});
    throw error;
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

export async function readUgoiraManifest(filename: string): Promise<UgoiraManifest> {
  let manifest: UgoiraManifest | undefined;
  const files = new Set<string>();
  await visitZip(filename, async (entry, read) => {
    if (entry.fileName === 'manifest.json') manifest = ugoiraManifestSchema.parse(JSON.parse((await read()).toString('utf8')));
    else files.add(entry.fileName);
  });
  if (!manifest || manifest.frames.length !== files.size || manifest.frames.some(frame => !files.has(frame.file))) throw new Error('无效的 ugoira 帧清单');
  return manifest;
}

export async function readUgoiraFrame(filename: string, index: number): Promise<Buffer> {
  const manifest = await readUgoiraManifest(filename);
  if (!Number.isInteger(index) || index < 0 || index >= manifest.frames.length) throw new Error('ugoira 帧不存在');
  let result: Buffer | undefined;
  await visitZip(filename, async (entry, read) => {
    if (entry.fileName === manifest.frames[index].file) result = await read();
  });
  if (!result) throw new Error('ugoira 帧缺失');
  return result;
}

export async function imageInput(filename: string): Promise<string | Buffer> {
  return isUgoira(filename) ? readUgoiraFrame(filename, 0) : filename;
}
