import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch, ProxyAgent, type Dispatcher, type Response } from 'undici';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config.js';
import { getFileCategory } from './file-classifier.js';
import { readFanboxSettings, rotateFanboxSession } from './fanbox-auth.js';
import { FanboxChallengeClient, type FanboxChallengeResolver } from './fanbox-challenge.js';

export function parseFanboxUrl(value: string): { id: string; url: string } {
  try {
    const url = new URL(value.trim());
    const canonical = ['www.fanbox.cc', 'fanbox.cc'].includes(url.hostname);
    const creator = canonical ? /^\/@([A-Za-z0-9_-]+)\/posts\/([1-9]\d{0,19})\/?$/.exec(url.pathname)
      : /^([A-Za-z0-9_-]+)\.fanbox\.cc$/.exec(url.hostname);
    const post = canonical ? creator?.[2] : /^\/posts\/([1-9]\d{0,19})\/?$/.exec(url.pathname)?.[1];
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !creator || !post ||
        ['api', 'downloads', 'www'].includes(creator[1])) throw new Error();
    return { id: post, url: `https://www.fanbox.cc/@${creator[1]}/posts/${post}` };
  } catch { throw new Error('请输入有效的 FANBOX 帖子网址'); }
}

export function validateFanboxMediaUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        !['downloads.fanbox.cc', 'fanbox.pixiv.net'].includes(url.hostname) ||
        getFileCategory(url.pathname) === 'skip' || path.extname(url.pathname).toLowerCase() === '.ugoira') throw new Error();
    return url;
  } catch { throw new Error('FANBOX 返回了不支持的资源地址'); }
}

export interface FanboxMedia { url: string; extension: string; category: 'image' | 'video' }
export interface FanboxPost { title: string; author: string; media: FanboxMedia[]; skippedCount: number }
const itemSchema = z.object({ originalUrl: z.string().optional(), url: z.string().optional() });
const bodySchema = z.object({
  images: z.array(itemSchema).max(1000).optional(), files: z.array(itemSchema).max(1000).optional(),
  imageMap: z.record(itemSchema).optional(), fileMap: z.record(itemSchema).optional(),
  blocks: z.array(z.object({ type: z.string(), imageId: z.string().optional(), fileId: z.string().optional() })).max(10000).optional(),
  html: z.string().optional(), video: z.unknown().optional(),
});
const postSchema = z.object({
  id: z.string(), title: z.string().min(1).max(10000), creatorId: z.string(),
  user: z.object({ name: z.string().max(10000) }).nullish(), type: z.string().optional(),
  isRestricted: z.boolean().optional(), body: bodySchema.nullish(),
});
const accessError = () => new Error('FANBOX 帖子不可访问');
const verificationError = () => new Error('FANBOX 拦截了服务器请求，请稍后重试');
const cleanText = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);

export function extractFanboxPost(raw: unknown, id: string): FanboxPost {
  const result = postSchema.safeParse(raw);
  if (!result.success || result.data.id !== id) throw new Error('FANBOX 返回了无效的帖子数据');
  const post = result.data;
  if (post.isRestricted || !post.body) throw accessError();
  const body = post.body;
  const media: FanboxMedia[] = [];
  const seen = new Set<string>();
  let skippedCount = 0;
  function add(item: z.infer<typeof itemSchema> | undefined) {
    const value = item?.originalUrl ?? item?.url;
    if (!value) throw new Error('FANBOX 资源列表不完整');
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('FANBOX 返回了无效的资源地址'); }
    const category = getFileCategory(url.pathname);
    const extension = path.extname(url.pathname).toLowerCase();
    // .ugoira is a local archive container, not a FANBOX image format.
    if (category === 'skip' || extension === '.ugoira') { skippedCount++; return; }
    validateFanboxMediaUrl(value);
    if (seen.has(url.href)) return;
    seen.add(url.href);
    media.push({ url: url.href, extension, category });
    if (media.length > 1000) throw new Error('FANBOX 帖子资源过多');
  }
  if (body.blocks) {
    for (const block of body.blocks ?? []) {
      if (block.type === 'image') add(body.imageMap?.[block.imageId ?? '']);
      else if (block.type === 'file') add(body.fileMap?.[block.fileId ?? '']);
      else if (['embed', 'url_embed'].includes(block.type)) skippedCount++;
    }
  } else {
    for (const item of body.images ?? []) add(item);
    for (const item of body.files ?? []) add(item);
    if (body.video) skippedCount++;
  }
  // Legacy posts use HTML; inspect only direct attachment links, never prose or remote embeds.
  if (body.html) for (const match of body.html.matchAll(/\b(?:href|data-src-original)\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1].replace(/&amp;/g, '&');
    let url: URL;
    try { url = new URL(value); } catch { continue; }
    if (['fanbox.pixiv.net', 'downloads.fanbox.cc'].includes(url.hostname)) add({ url: value });
  }
  return { title: cleanText(post.title) || `FANBOX ${id}`, author: cleanText(post.user?.name ?? '') || cleanText(post.creatorId), media, skippedCount };
}

export class FanboxClient {
  constructor(
    private dispatcher?: Dispatcher,
    private credentials = readFanboxSettings,
    private rotate = rotateFanboxSession,
    private challenge?: FanboxChallengeResolver,
  ) {}

  private async request(url: string, media: boolean, signal?: AbortSignal): Promise<Response> {
    if (media) validateFanboxMediaUrl(url);
    else if (!/^https:\/\/api\.fanbox\.cc\/post\.info\?postId=[1-9]\d{0,19}$/.test(url)) throw new Error('无效的 FANBOX API 地址');
    signal?.throwIfAborted();
    // Read on every request so externally synchronized files take effect without a restart.
    // FANBOX cookies are never sent to the separate pixiv.net image host.
    const credentialHost = new URL(url).hostname.endsWith('.fanbox.cc');
    const { sessionId } = credentialHost ? this.credentials() : { sessionId: '' };
    let response: Response;
    try {
      response = await fetch(url, { dispatcher: this.dispatcher, redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
        headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://www.fanbox.cc', Referer: 'https://www.fanbox.cc/',
          ...(sessionId ? { Cookie: `FANBOXSESSID=${sessionId}` } : {}),
          ...(!media ? { Accept: 'application/json' } : {}),
        },
      });
    } catch { signal?.throwIfAborted(); throw new Error('无法连接 FANBOX，请检查服务端网络或 AOI_PROXY_URL'); }
    const contentType = response.headers.get('content-type') ?? '';
    const blocked = response.headers.get('cf-mitigated') === 'challenge' ||
      (response.status === 403 && !contentType.includes('application/json')) ||
      ((response.ok || response.status === 503) && contentType.includes('text/html'));
    if (!media && blocked && response.status !== 429) {
      await response.body?.cancel();
      if (!this.challenge) throw verificationError();
      response = await this.challenge.resolve(url, sessionId, signal);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 && !response.headers.get('content-type')?.includes('application/json')) throw verificationError();
      if ([401, 403].includes(response.status)) throw accessError();
      if (response.status === 404) throw new Error('FANBOX 帖子或资源不存在，可能已删除或无权访问');
      if (response.status === 429) throw new Error('FANBOX 请求过于频繁，请稍后重试');
      throw new Error(`FANBOX 请求失败（HTTP ${response.status}）`);
    }
    if (!media && sessionId) {
      try { this.rotate(sessionId, response.headers.getSetCookie()); }
      catch (error) { await response.body?.cancel(); throw error; }
    }
    return response;
  }

  async post(id: string, signal?: AbortSignal): Promise<FanboxPost> {
    const response = await this.request(`https://api.fanbox.cc/post.info?postId=${id}`, false, signal);
    try {
      if (!response.headers.get('content-type')?.includes('application/json')) throw verificationError();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body!) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new Error('FANBOX 响应过大');
        chunks.push(chunk);
      }
      let envelope: { body?: unknown; error?: unknown };
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('FANBOX 返回了无效数据'); }
      if (!envelope || envelope.error || !envelope.body) throw accessError();
      const body = envelope.body;
      const post = typeof body === 'object' && body !== null && 'post' in body ? body.post : body;
      if (!post) throw accessError();
      return extractFanboxPost(post, id);
    } finally { if (!response.bodyUsed) await response.body?.cancel(); }
  }

  async download(media: FanboxMedia, destination: string, limit: number, signal?: AbortSignal): Promise<number> {
    if (limit <= 0) throw new Error('FANBOX 资源超出导入大小限制');
    const response = await this.request(media.url, true, signal);
    const temporary = `${destination}.part`;
    let size = 0;
    try {
      const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase() ?? '';
      if (!(mime.startsWith(`${media.category}/`) || mime === 'application/octet-stream')) throw new Error('FANBOX 返回的文件类型与资源不符');
      if (Number(response.headers.get('content-length')) > limit) throw new Error('FANBOX 资源超出导入大小限制');
      await pipeline(Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0]),
        new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(size > limit ? new Error('FANBOX 资源超出导入大小限制') : null, chunk);
        } }), fs.createWriteStream(temporary), { signal });
      if (!size) throw new Error('FANBOX 返回了空资源');
      if (media.category === 'image') {
        try {
          const info = await sharp(temporary, { limitInputPixels: config.maxImagePixels }).metadata();
          if (!info.width || !info.height) throw new Error();
        } catch { throw new Error('FANBOX 返回了无效的图片'); }
      }
      signal?.throwIfAborted();
      await fs.promises.rename(temporary, destination);
      return size;
    } finally {
      if (!response.bodyUsed) await response.body?.cancel();
      await fs.promises.rm(temporary, { force: true });
    }
  }
}

let client: FanboxClient | undefined;
export function getFanboxClient(): FanboxClient {
  return client ??= new FanboxClient(
    config.outboundProxyUrl ? new ProxyAgent({ uri: config.outboundProxyUrl, proxyTunnel: true }) : undefined,
    readFanboxSettings, rotateFanboxSession,
    config.flaresolverr.url ? new FanboxChallengeClient(config.flaresolverr.url, config.flaresolverr.proxyUrl ?? config.outboundProxyUrl) : undefined,
  );
}
