import { TaskError } from '../../../shared/task-errors.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { API, File as MegaFile } from 'megajs';
import type { MegaMetadata, TaskErrorCode } from '../../../shared/types.js';
import { config } from '../config/index.js';
import { normalizeRelativePath, resolveWithin } from './safe-path.js';
import { MegaPasswordError, resolveMegaUrl } from './mega-link.js';
import { createOutboundFetch } from './outbound-fetch.js';

export interface MegaDownloadResult {
  kind: 'archive' | 'folder';
  name: string;
  totalBytes: number;
  files: Array<{ relativePath: string; fileSize: number }>;
  contentPath: string;
}

function safeName(name: string | null): string {
  if (!name) throw new MegaPasswordError('无法解密 MEGA 文件名，请检查分享密钥', 'PASSWORD_INCORRECT');
  const value = normalizeRelativePath(name, 'MEGA filename');
  if (value.includes('/') || /[:*?"<>|]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('MEGA 分享包含不安全的文件名');
  }
  return value;
}

export function planMegaFiles(root: MegaFile): Array<{ file: MegaFile; relativePath: string; fileSize: number }> {
  const result: Array<{ file: MegaFile; relativePath: string; fileSize: number }> = [];
  const visited = new Set<MegaFile>();
  const paths = new Set<string>();
  let total = 0;
  function visit(file: MegaFile, prefix: string, depth: number): void {
    if (depth > 128 || visited.has(file) || visited.size >= config.maxArchiveEntries) throw new TaskError('RESOURCE_LIMIT', 'MEGA 分享目录层级或文件数量超出限制');
    visited.add(file);
    const relativePath = normalizeRelativePath(prefix + safeName(file.name));
    const identity = relativePath.toLowerCase();
    if (paths.has(identity)) throw new Error('MEGA 分享包含重复或大小写冲突的路径');
    paths.add(identity);
    if (file.directory) {
      for (const child of file.children ?? []) visit(child, `${relativePath}/`, depth + 1);
    } else {
      if (!Number.isSafeInteger(file.size) || file.size! < 0) throw new Error('MEGA 文件大小无效');
      total += file.size!;
      if (!Number.isSafeInteger(total) || total > (root.directory ? config.maxExtractedSize : config.maxUploadSize)) throw new TaskError('RESOURCE_LIMIT', 'MEGA 分享超过导入大小限制');
      result.push({ file, relativePath, fileSize: file.size! });
    }
  }
  safeName(root.name);
  if (root.directory) for (const child of root.children ?? []) visit(child, '', 0);
  else visit(root, '', 0);
  if (!result.length) throw new Error('MEGA 文件夹为空');
  if (!root.directory && !/\.(zip|rar|7z)$/i.test(root.name!)) throw new Error('MEGA 单文件分享仅支持 ZIP、RAR 和 7z 压缩包');
  return result;
}

interface MegaShareOptions {
  url: string;
  sharePassword?: string;
  signal?: AbortSignal;
}

export function megaShareTitle(filename: string, kind: 'archive' | 'folder'): string {
  return ((kind === 'archive' ? filename.replace(/\.(zip|rar|7z)$/i, '') : filename) || filename)
    .replace(/[\0\r\n]/g, ' ').slice(0, 200);
}

async function withMegaShare<T>(options: MegaShareOptions,
  consume: (root: MegaFile, api: API, signal: AbortSignal) => Promise<T>): Promise<T> {
  const url = await resolveMegaUrl(options.url, options.sharePassword);
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const operationSignal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const outbound = createOutboundFetch(config.outboundProxyUrl);
  const api = new API(false, { fetch: async (input, init) => {
    const endpoint = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port ||
      !['mega.nz', 'mega.co.nz'].some(domain => endpoint.hostname === domain || endpoint.hostname.endsWith(`.${domain}`))) {
      throw new Error('MEGA 返回了不受信任的下载地址');
    }
    const signals = [AbortSignal.timeout(60_000), operationSignal, init?.signal].filter((value): value is AbortSignal => !!value);
    const response = await outbound.fetch(endpoint, { ...init, signal: AbortSignal.any(signals), redirect: 'error' });
    const range = /\/(\d+)-(\d+)$/.exec(endpoint.pathname);
    const maxBytes = range ? Number(range[2]) - Number(range[1]) + 1
      : Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, config.maxArchiveEntries * 2_048));
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new TaskError('RESOURCE_LIMIT', 'MEGA 响应超过资源限制');
    }
    if (!response.body) return response;
    let received = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, sink) {
        received += chunk.byteLength;
        if (received > maxBytes) throw new TaskError('RESOURCE_LIMIT', 'MEGA 响应超过资源限制');
        sink.enqueue(chunk);
      },
    }));
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
  } });
  try {
    const attributes = MegaFile.fromURL(url, { api }).loadAttributes();
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(operationSignal.reason);
      operationSignal.addEventListener('abort', abort, { once: true });
    });
    const root = await Promise.race([attributes, aborted]).finally(() => {
      if (abort) operationSignal.removeEventListener('abort', abort);
    });
    return await consume(root, api, operationSignal);
  } catch (error) {
    if (error instanceof Error && /attributes could not be decrypted/i.test(error.message)) {
      throw new MegaPasswordError('MEGA 解密密钥错误', 'PASSWORD_INCORRECT');
    }
    // MEGAJS exposes protocol error identifiers in the message, not Error.code.
    const identifier = error instanceof Error ? /^([A-Z]+) \(-\d+\)/.exec(error.message)?.[1] : undefined;
    const codes: Record<string, TaskErrorCode> = { EOVERQUOTA: 'SOURCE_QUOTA', ESHAREROVERQUOTA: 'SOURCE_QUOTA',
      ERATELIMIT: 'RATE_LIMITED', EAGAIN: 'NETWORK_ERROR', ENOENT: 'SOURCE_UNAVAILABLE' };
    if (identifier && codes[identifier]) throw new TaskError(codes[identifier], (error as Error).message);
    throw error;
  } finally {
    // Public API(false) has no keepalive. Aborting also stops in-flight chunk fetches;
    // closing API itself would make an SDK-scheduled retry throw outside its promise.
    controller.abort();
    await outbound.close();
  }
}

/** Public links expose node names, but do not expose an owner's display name. */
export async function describeMegaShare(options: MegaShareOptions): Promise<MegaMetadata> {
  return withMegaShare(options, async root => {
    const entries = planMegaFiles(root);
    const filename = safeName(root.name);
    const kind = root.directory ? 'folder' : 'archive';
    return { title: megaShareTitle(filename, kind), filename, kind,
      totalBytes: entries.reduce((sum, entry) => sum + entry.fileSize, 0) };
  });
}

export async function downloadMegaShare(options: MegaShareOptions & {
  destination: string;
  onProgress?: (progress: { name: string; kind: 'archive' | 'folder'; totalBytes: number; transferredBytes: number }) => void;
}): Promise<MegaDownloadResult> {
  return withMegaShare(options, async (root, api, operationSignal) => {
    const entries = planMegaFiles(root);
    const name = safeName(root.name);
    const totalBytes = entries.reduce((sum, entry) => sum + entry.fileSize, 0);
    const contentPath = resolveWithin(options.destination, 'contents');
    const receiptsPath = resolveWithin(options.destination, 'receipts');
    await fs.promises.mkdir(contentPath, { recursive: true });
    await fs.promises.mkdir(receiptsPath, { recursive: true });
    const receiptFor = (entry: typeof entries[number]) => resolveWithin(receiptsPath,
      createHash('sha256').update(entry.relativePath).update(entry.file.key ?? '').digest('hex'));
    const isComplete = (entry: typeof entries[number]) => {
      const destination = resolveWithin(contentPath, entry.relativePath);
      return fs.existsSync(receiptFor(entry)) && fs.existsSync(destination) && fs.statSync(destination).size === entry.fileSize;
    };
    const remainingBytes = entries.reduce((sum, entry) => sum + (isComplete(entry) ? 0 : entry.fileSize), 0);
    const space = await fs.promises.statfs(options.destination);
    if (remainingBytes > Number(space.bavail) * Number(space.bsize)) throw new TaskError('STORAGE_FULL', '磁盘剩余空间不足');
    let transferredBytes = 0;
    const progress = () => options.onProgress?.({ name, kind: root.directory ? 'folder' : 'archive', totalBytes, transferredBytes });
    progress();
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      entry.file.api = api; // MEGAJS creates folder children with the global API by default.
      const destination = resolveWithin(contentPath, entry.relativePath);
      const receipt = receiptFor(entry);
      if (isComplete(entry)) {
        transferredBytes += entry.fileSize;
        progress();
        continue;
      }
      const partial = `${receipt}.part`;
      let received = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > entry.fileSize) return callback(new TaskError('RESOURCE_LIMIT', 'MEGA 实际文件大小超出声明值'));
        transferredBytes += chunk.length;
        progress();
        callback(null, chunk);
      } });
      // Always restart an incomplete file so MEGAJS verifies its entire MAC.
      // MEGAJS's chunked downloader honors backpressure and handles fetch aborts.
      const stream = entry.file.download({ forceHttps: true, maxConnections: 2,
        handleRetries: (_attempt: number, error: Error | null, callback: (error: Error | null) => void) => callback(error),
      }) as unknown as Readable;
      // The SDK uses a legacy duplex stream without autoDestroy/close semantics.
      // Bridge it to a native stream so pipeline completes and propagates aborts.
      const source = new PassThrough();
      stream.on('error', error => source.destroy(error));
      source.once('close', () => stream.destroy());
      stream.pipe(source);
      await pipeline(source, meter, fs.createWriteStream(partial), { signal: operationSignal });
      if (received !== entry.fileSize) throw new Error('MEGA 下载文件不完整');
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.rename(partial, destination);
      await fs.promises.writeFile(receipt, String(entry.fileSize));
    }
    return { kind: root.directory ? 'folder' : 'archive', name, totalBytes,
      files: entries.map(({ relativePath, fileSize }) => ({ relativePath, fileSize })),
      contentPath: root.directory ? contentPath : resolveWithin(contentPath, name),
    };
  });
}
