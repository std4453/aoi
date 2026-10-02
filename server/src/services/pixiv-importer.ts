import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import { z } from 'zod';
import sharp from 'sharp';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { getPack, updatePackStats, updatePackStructureType } from '../db/repositories.js';
import { ensureDir, getExtractedImagesDir } from './storage.js';
import { resolveWithin } from './safe-path.js';
import { scheduleVerification } from './content-verification.js';

export function parsePixivUrl(value: string): { id: string; url: string } {
  const url = new URL(value.trim());
  const match = /^\/(?:[a-z]{2}\/)?artworks\/([1-9]\d{0,19})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['www.pixiv.net', 'pixiv.net'].includes(url.hostname) ||
      url.port || url.username || url.password || !match) {
    throw new Error('请输入有效的 Pixiv 作品网址，例如 https://www.pixiv.net/artworks/150150651');
  }
  return { id: match[1], url: `https://www.pixiv.net/artworks/${match[1]}` };
}

export function validatePixivImageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^i\d*\.pximg\.net$/.test(url.hostname) ||
      url.port || url.username || url.password || !/\.(jpg|jpeg|png|gif|webp)$/i.test(url.pathname)) {
    throw new Error('Pixiv 返回了不支持的原图地址');
  }
  return url;
}

const metadataSchema = z.object({
  title: z.string().min(1), userName: z.string(),
  illustType: z.number().int(), pageCount: z.number().int().positive().max(1000),
});
const pagesSchema = z.array(z.object({ urls: z.object({ original: z.string().url() }) })).min(1).max(1000);
const maxImageBytes = 100 * 1024 * 1024;

// A dispatcher can be injected by tests without exposing arbitrary URLs to clients.
export class PixivClient {
  constructor(private dispatcher?: Dispatcher, private cookie = '') {}

  async request(url: string, image = false) {
    if (image) validatePixivImageUrl(url);
    else if (!/^https:\/\/www\.pixiv\.net\/ajax\/illust\/[1-9]\d{0,19}(?:\/pages)?$/.test(url)) {
      throw new Error('Invalid Pixiv API URL');
    }
    let response;
    try {
      response = await fetch(url, {
        dispatcher: this.dispatcher, redirect: 'manual', signal: AbortSignal.timeout(120_000),
        headers: {
          Referer: 'https://www.pixiv.net/', 'User-Agent': 'Mozilla/5.0 AoI/1.0',
          ...(!image && this.cookie ? { Cookie: this.cookie } : {}),
        },
      });
    } catch {
      throw new Error('无法连接 Pixiv，请检查服务端网络或 PIXIV_PROXY_URL 后重试');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new Error('Pixiv 拒绝访问，请检查服务端 PIXIV_COOKIE 或作品访问权限');
      if (response.status === 404) throw new Error('Pixiv 作品或原图不存在，可能已被删除');
      if (response.status === 429) throw new Error('Pixiv 请求过于频繁，请稍后重试');
      throw new Error(`Pixiv 请求失败（HTTP ${response.status}）`);
    }
    return response;
  }

  async json(url: string): Promise<unknown> {
    const response = await this.request(url);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body!) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Pixiv 响应过大');
        chunks.push(chunk);
      }
      const result = z.object({ error: z.boolean(), body: z.unknown() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (result.error) throw new Error('Pixiv 作品不可访问，请检查网址或服务端 PIXIV_COOKIE');
      return result.body;
    } finally {
      if (!response.bodyUsed) await response.body?.cancel();
    }
  }

  async artwork(id: string) {
    const metadata = metadataSchema.parse(await this.json(`https://www.pixiv.net/ajax/illust/${id}`));
    if (metadata.illustType === 2) throw new Error('暂不支持 Pixiv 动图（ugoira），请导入插画或漫画');
    if (![0, 1].includes(metadata.illustType)) throw new Error('不支持的 Pixiv 作品类型');
    const pages = pagesSchema.parse(await this.json(`https://www.pixiv.net/ajax/illust/${id}/pages`));
    if (pages.length !== metadata.pageCount) throw new Error('Pixiv 原图列表不完整，请稍后重试');
    for (const page of pages) validatePixivImageUrl(page.urls.original);
    return { metadata, pages };
  }

  async download(url: string, destination: string, limit: number): Promise<number> {
    const response = await this.request(url, true);
    const temporary = `${destination}.part`;
    let size = 0;
    try {
      if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('Pixiv 返回的文件不是图片');
      if (Number(response.headers.get('content-length')) > limit) throw new Error('Pixiv 图片超出导入大小限制');
      await pipeline(
        Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0]),
        new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(size > limit ? new Error('Pixiv 图片超出导入大小限制') : null, chunk);
        } }),
        fs.createWriteStream(temporary),
      );
      const metadata = await sharp(temporary, { limitInputPixels: config.maxImagePixels }).metadata();
      if (!metadata.width || !metadata.height) throw new Error('Pixiv 原图无效');
      // Publish only a complete, validated file. Interrupted .part files are overwritten on retry.
      await fs.promises.rename(temporary, destination);
      return size;
    } finally {
      if (!response.bodyUsed) await response.body?.cancel();
      await fs.promises.rm(temporary, { force: true });
    }
  }
}

let client: PixivClient | undefined;
export function getPixivClient(): PixivClient {
  return client ??= new PixivClient(config.pixivProxyUrl ? new ProxyAgent(config.pixivProxyUrl) : undefined, config.pixivCookie);
}

export async function importPixivPack(
  packId: string,
  onProgress: (completed: number, total: number, bytes: number) => void,
  pixiv = getPixivClient(),
): Promise<void> {
  const pack = getPack(packId);
  if (!pack || pack.originalFormat !== 'pixiv') throw new Error('Pixiv 图包不存在');
  const { id } = parsePixivUrl(pack.originalFilename);
  const { metadata, pages } = await pixiv.artwork(id);
  const directory = getExtractedImagesDir(packId);
  ensureDir(directory);
  let bytes = 0;
  onProgress(0, pages.length, 0);
  for (const [index, page] of pages.entries()) {
    const url = validatePixivImageUrl(page.urls.original);
    const extension = url.pathname.split('.').pop()!.toLowerCase();
    const destination = resolveWithin(directory, `${id}_p${String(index).padStart(3, '0')}.${extension}`);
    // Redownload on recovery so a changed upstream work cannot mix old and new pages.
    bytes += await pixiv.download(url.href, destination, Math.min(maxImageBytes, config.maxUploadSize - bytes));
    onProgress(index + 1, pages.length, bytes);
  }
  const expected = new Set(pages.map((page, index) => `${id}_p${String(index).padStart(3, '0')}.${new URL(page.urls.original).pathname.split('.').pop()!.toLowerCase()}`));
  for (const filename of await fs.promises.readdir(directory)) {
    if (!expected.has(filename)) await fs.promises.rm(resolveWithin(directory, filename), { force: true });
  }
  getDb().transaction(() => {
    const name = pack.name === `Pixiv ${id}` ? `${metadata.title} - ${metadata.userName}`.replace(/[\0\r\n]/g, ' ').slice(0, 200) : pack.name;
    getDb().prepare('UPDATE packs SET name = ?, original_size = ? WHERE id = ?').run(name, bytes, packId);
    updatePackStats(packId, { imageCount: pages.length, videoCount: 0, totalImagesSize: bytes, totalVideosSize: 0 });
    updatePackStructureType(packId, 'flat');
    scheduleVerification(packId);
  })();
}
