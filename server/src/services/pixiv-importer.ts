import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import { z } from 'zod';
import sharp from 'sharp';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { getPack, getLatestJob, updatePackStats, updatePackStructureType, createTag, listTags, setPackTags } from '../db/repositories.js';
import { ensureDir, getExtractedImagesDir } from './storage.js';
import { resolveWithin } from './safe-path.js';
import { scheduleVerification } from './content-verification.js';
import { PixivAuth, readPixivJson, readPixivSettings } from './pixiv-auth.js';
import { createUgoira, ugoiraFramesSchema } from './ugoira.js';
import type { Tag } from '../../../shared/types.js';

export function parsePixivUrl(value: string): { id: string; url: string } {
  const url = new URL(value.trim());
  const match = /^\/(?:[a-z]{2}\/)?artworks\/([1-9]\d{0,19})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['www.pixiv.net', 'pixiv.net'].includes(url.hostname) ||
      url.port || url.username || url.password || !match) {
    throw new Error('请输入有效的 Pixiv 作品网址，例如 https://www.pixiv.net/artworks/150150651');
  }
  return { id: match[1], url: `https://www.pixiv.net/artworks/${match[1]}` };
}

export function validatePixivImageUrl(value: string, zip = false): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^i\d*\.pximg\.net$/.test(url.hostname) ||
      url.port || url.username || url.password || !(zip ? /^\/img-zip-ugoira\/.+\.zip$/ : /\.(jpg|jpeg|png|gif|webp)$/i).test(url.pathname)) {
    throw new Error('Pixiv 返回了不支持的原图地址');
  }
  return url;
}

const metadataSchema = z.object({
  title: z.string().min(1), userName: z.string(),
  illustType: z.number().int(), pageCount: z.number().int().positive().max(1000),
  tags: z.object({ tags: z.array(z.object({ tag: z.string() })).max(1000) }).optional(),
});
const appArtworkSchema = z.object({ illust: z.object({
  title: z.string().min(1), user: z.object({ name: z.string() }), type: z.enum(['illust', 'manga', 'ugoira']),
  page_count: z.number().int().positive().max(1000), tags: z.array(z.object({ name: z.string() })).max(1000),
  meta_single_page: z.object({ original_image_url: z.string().optional() }),
  meta_pages: z.array(z.object({ image_urls: z.object({ original: z.string() }) })).max(1000),
}) });
const pagesSchema = z.array(z.object({ urls: z.object({ original: z.string().url() }) })).min(1).max(1000);
const maxImageBytes = 100 * 1024 * 1024;

// A dispatcher can be injected by tests without exposing arbitrary URLs to clients.
export class PixivClient {
  private auth?: PixivAuth;
  constructor(private dispatcher?: Dispatcher, private cookie = '', refreshToken = '') {
    if (refreshToken) this.auth = new PixivAuth(refreshToken, dispatcher);
  }

  private accessError(): Error {
    return new Error(this.auth
      ? 'Pixiv 拒绝访问：当前登录账号无权查看该作品，请检查作品权限，或在外部来源设置中更新 Pixiv refresh-token。'
      : 'Pixiv 拒绝匿名访问，且未配置 refresh-token。该作品可能需要登录才能下载（也可能已删除或限制访问）。请打开「外部来源 → Pixiv」，使用 gallery-dl oauth:pixiv 获取 refresh-token，保存后重试。');
  }

  async request(url: string, image = false, zip = false, signal?: AbortSignal) {
    if (image) validatePixivImageUrl(url, zip);
    else if (!/^https:\/\/www\.pixiv\.net\/ajax\/illust\/[1-9]\d{0,19}(?:\/pages|\/ugoira_meta)?$/.test(url)) {
      throw new Error('Invalid Pixiv API URL');
    }
    let response;
    try {
      response = await fetch(url, {
        dispatcher: this.dispatcher, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
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
      if ([401, 403].includes(response.status)) throw this.accessError();
      if (response.status === 404) throw new Error(!image && !this.auth ? 'Pixiv 找不到作品，可能已删除或仅登录可见。当前未配置 refresh-token；请核对网址，或在「外部来源 → Pixiv」配置登录态后重试。' : 'Pixiv 作品或原图不存在，可能已被删除');
      if (response.status === 429) throw new Error('Pixiv 请求过于频繁，请稍后重试');
      throw new Error(`Pixiv 请求失败（HTTP ${response.status}）`);
    }
    return response;
  }

  async json(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(url, false, false, signal);
    const result = z.object({ error: z.boolean(), body: z.unknown() }).parse(await readPixivJson(response));
    if (result.error) throw this.accessError();
    return result.body;
  }

  async describe(id: string, signal?: AbortSignal) {
    if (this.auth) {
      const { illust } = appArtworkSchema.parse(await this.auth.request('illust/detail', id, signal));
      return {
        metadata: { title: illust.title, userName: illust.user.name, illustType: illust.type === 'ugoira' ? 2 : illust.type === 'manga' ? 1 : 0, pageCount: illust.page_count },
        tagNames: illust.tags.map(tag => tag.name),
        pages: illust.meta_pages.length ? illust.meta_pages.map(page => ({ urls: { original: page.image_urls.original } })) :
          illust.meta_single_page.original_image_url ? [{ urls: { original: illust.meta_single_page.original_image_url } }] : [],
      };
    }
    const metadata = metadataSchema.parse(await this.json(`https://www.pixiv.net/ajax/illust/${id}`, signal));
    return { metadata, tagNames: metadata.tags?.tags.map(tag => tag.tag) ?? [], pages: undefined };
  }

  async artwork(id: string, signal?: AbortSignal) {
    const { metadata, tagNames, pages: appPages } = await this.describe(id, signal);
    if (metadata.illustType === 2) {
      const raw = this.auth ? z.object({ ugoira_metadata: z.object({ zip_urls: z.object({ medium: z.string() }), frames: ugoiraFramesSchema }) }).parse(await this.auth.request('ugoira/metadata', id, signal)).ugoira_metadata :
        z.object({ originalSrc: z.string(), frames: ugoiraFramesSchema }).parse(await this.json(`https://www.pixiv.net/ajax/illust/${id}/ugoira_meta`, signal));
      const zipUrl = 'originalSrc' in raw ? raw.originalSrc : raw.zip_urls.medium.replace('_ugoira600x600.zip', '_ugoira1920x1080.zip');
      validatePixivImageUrl(zipUrl, true);
      return { metadata, tagNames, pages: [], ugoira: { zipUrl, frames: raw.frames } };
    }
    if (![0, 1].includes(metadata.illustType)) throw new Error('不支持的 Pixiv 作品类型');
    const pages = pagesSchema.parse(appPages ?? await this.json(`https://www.pixiv.net/ajax/illust/${id}/pages`, signal));
    if (pages.length !== metadata.pageCount) throw new Error('Pixiv 原图列表不完整，请稍后重试');
    for (const page of pages) validatePixivImageUrl(page.urls.original);
    return { metadata, tagNames, pages, ugoira: undefined };
  }

  async download(url: string, destination: string, limit: number, zip = false, signal?: AbortSignal): Promise<number> {
    const response = await this.request(url, true, zip, signal);
    const temporary = `${destination}.part`;
    let size = 0;
    try {
      if (!zip && !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Pixiv 返回的文件不是图片');
      if (Number(response.headers.get('content-length')) > limit) throw new Error('Pixiv 图片超出导入大小限制');
      await pipeline(
        Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0]),
        new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(size > limit ? new Error('Pixiv 图片超出导入大小限制') : null, chunk);
        } }),
        fs.createWriteStream(temporary),
      );
      if (!zip) {
        const metadata = await sharp(temporary, { limitInputPixels: config.maxImagePixels }).metadata();
        if (!metadata.width || !metadata.height) throw new Error('Pixiv 原图无效');
      }
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
let clientToken: string | undefined;
let proxy: ProxyAgent | undefined;
export function getPixivClient(): PixivClient {
  const { refreshToken } = readPixivSettings();
  if (!client || refreshToken !== clientToken) {
    if (config.pixivProxyUrl) proxy ??= new ProxyAgent(config.pixivProxyUrl);
    client = new PixivClient(proxy, config.pixivCookie, refreshToken);
    clientToken = refreshToken;
  }
  return client;
}

export function ensurePixivTags(names: string[]): Tag[] {
  return getDb().transaction(() => {
    const existing = new Map(listTags().map(tag => [tag.name, tag]));
    const safe = [...new Set(names.map(name => name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)).filter(Boolean))].slice(0, 1000);
    return safe.map(name => existing.get(name) ?? createTag(name));
  })();
}

export async function importPixivPack(
  packId: string,
  onProgress: (completed: number, total: number, bytes: number) => void,
  pixiv = getPixivClient(),
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const pack = getPack(packId);
  if (!pack || pack.originalFormat !== 'pixiv') throw new Error('Pixiv 图包不存在');
  const { id } = parsePixivUrl(pack.originalFilename);
  const { metadata, tagNames, pages, ugoira } = await pixiv.artwork(id, signal);
  signal?.throwIfAborted();
  const directory = getExtractedImagesDir(packId);
  ensureDir(directory);
  let bytes = 0;
  onProgress(0, ugoira ? 1 : pages.length, 0);
  if (ugoira) {
    const zipPath = resolveWithin(directory, `${id}.zip`);
    try {
      await pixiv.download(ugoira.zipUrl, zipPath, Math.min(maxImageBytes, config.maxUploadSize), true, signal);
      const destination = resolveWithin(directory, `${id}.ugoira`);
      await createUgoira(zipPath, destination, ugoira.frames);
      bytes = (await fs.promises.stat(destination)).size;
      if (bytes > config.maxUploadSize) throw new Error('ugoira 超出导入大小限制');
      onProgress(1, 1, bytes);
    } finally { await fs.promises.rm(zipPath, { force: true }); }
  }
  for (const [index, page] of pages.entries()) {
    signal?.throwIfAborted();
    const url = validatePixivImageUrl(page.urls.original);
    const extension = url.pathname.split('.').pop()!.toLowerCase();
    const destination = resolveWithin(directory, `${id}_p${String(index).padStart(3, '0')}.${extension}`);
    // Redownload on recovery so a changed upstream work cannot mix old and new pages.
    bytes += await pixiv.download(url.href, destination, Math.min(maxImageBytes, config.maxUploadSize - bytes), false, signal);
    onProgress(index + 1, pages.length, bytes);
  }
  const expected = new Set(pages.map((page, index) => `${id}_p${String(index).padStart(3, '0')}.${new URL(page.urls.original).pathname.split('.').pop()!.toLowerCase()}`));
  if (ugoira) expected.add(`${id}.ugoira`);
  for (const filename of await fs.promises.readdir(directory)) {
    if (!expected.has(filename)) await fs.promises.rm(resolveWithin(directory, filename), { force: true });
  }
  signal?.throwIfAborted();
  getDb().transaction(() => {
    const options = JSON.parse(getLatestJob(packId, 'pixiv')?.options ?? '{}') as { autoName?: boolean; autoTags?: boolean };
    const name = (options.autoName ?? pack.name === `Pixiv ${id}`) ? metadata.title.replace(/[\0\r\n]/g, ' ').slice(0, 200) : pack.name;
    if (options.autoTags ?? true) {
      const tags = ensurePixivTags([metadata.userName, ...tagNames]);
      setPackTags(packId, [...new Set([...pack.tags.map(tag => tag.id), ...tags.map(tag => tag.id)])].slice(0, 1000));
    }
    getDb().prepare('UPDATE packs SET name = ?, original_size = ? WHERE id = ?').run(name, bytes, packId);
    updatePackStats(packId, { imageCount: ugoira ? 1 : pages.length, videoCount: 0, totalImagesSize: bytes, totalVideosSize: 0 });
    updatePackStructureType(packId, 'flat');
    scheduleVerification(packId);
  })();
}
