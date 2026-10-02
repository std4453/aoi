import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fetch, type Dispatcher, type Response } from 'undici';
import { z } from 'zod';
import { config } from '../config.js';
import { resolveWithin } from './safe-path.js';
import type { PixivSettings } from '../../../shared/types.js';

export const refreshTokenSchema = z.string().trim().max(8192).regex(/^[^\s]*$/);
const settingsPath = () => resolveWithin(config.dataDir, 'pixiv-settings.json');

export function readPixivSettings(): { refreshToken: string; source: PixivSettings['source'] } {
  try {
    const saved = z.object({ refreshToken: refreshTokenSchema }).parse(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
    return { ...saved, source: saved.refreshToken ? 'settings' : 'none' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 Pixiv 登录配置');
    return { refreshToken: config.pixivRefreshToken, source: config.pixivRefreshToken ? 'environment' : 'none' };
  }
}

export function savePixivSettings(refreshToken: string): void {
  const value = refreshTokenSchema.parse(refreshToken);
  const temporary = `${settingsPath()}.tmp`;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ refreshToken: value }), { mode: 0o600 });
  fs.renameSync(temporary, settingsPath());
}

export async function readPixivJson(response: Response): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body!) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Pixiv 响应过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Pixiv 返回了无效数据'); }
}

// Public Pixiv mobile OAuth client parameters (also used by gallery-dl).
// No user credential is embedded here. Tokens are sent only to the fixed OAuth/API hosts.
const appHeaders = { 'User-Agent': 'PixivIOSApp/7.19.1 (iOS 16.7.2; iPhone12,8)', 'App-OS': 'ios', 'App-OS-Version': '16.7.2', 'App-Version': '7.19.1' };

export class PixivAuth {
  private accessToken = '';
  private expiresAt = 0;
  private pending: Promise<string> | undefined;

  constructor(private refreshToken: string, private dispatcher?: Dispatcher) {}

  private token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return Promise.resolve(this.accessToken);
    return this.pending ??= this.refresh().finally(() => { this.pending = undefined; });
  }

  private async refresh(): Promise<string> {
    const time = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    let response: Response;
    try {
      response = await fetch('https://oauth.secure.pixiv.net/auth/token', {
        dispatcher: this.dispatcher, method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { ...appHeaders, 'X-Client-Time': time,
          'X-Client-Hash': createHash('md5').update(time + '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c').digest('hex') },
        body: new URLSearchParams({ client_id: 'MOBrBDS8blbauoSck0ZfDbtuzpyT', client_secret: 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj',
          grant_type: 'refresh_token', refresh_token: this.refreshToken, get_secure_url: '1' }),
      });
    } catch { throw new Error('无法连接 Pixiv 登录服务，请检查代理配置'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Pixiv 登录失败，请在设置中更新 refresh-token');
    }
    const envelope = await readPixivJson(response);
    const result = z.object({ response: z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }) }).safeParse(envelope);
    if (!result.success) throw new Error('Pixiv 登录失败，请在设置中更新 refresh-token');
    this.accessToken = result.data.response.access_token;
    this.expiresAt = Date.now() + Math.max(0, result.data.response.expires_in - 60) * 1000;
    return this.accessToken;
  }

  async request(endpoint: 'illust/detail' | 'ugoira/metadata', id: string, signal?: AbortSignal): Promise<unknown> {
    if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('Invalid artwork id');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token();
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(`https://app-api.pixiv.net/v1/${endpoint}?illust_id=${id}`, {
          dispatcher: this.dispatcher, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
          headers: { ...appHeaders, Authorization: `Bearer ${token}` },
        });
      } catch { throw new Error('无法连接 Pixiv，请检查服务端网络或代理'); }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel(); this.accessToken = ''; continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Pixiv 请求失败（HTTP ${response.status}），请检查登录态或作品权限`);
      }
      const data = await readPixivJson(response);
      if (!data || typeof data !== 'object' || 'error' in data) throw new Error('Pixiv 作品不可访问，请检查登录态或作品权限');
      return data;
    }
    throw new Error('Pixiv 登录已失效，请更新 refresh-token');
  }
}
