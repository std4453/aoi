import fs from 'node:fs';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { z } from 'zod';
import { config } from '../config/index.js';
import { saveFanboxSettings, validateFanboxSession } from './fanbox-auth.js';
import { exchangePixivCode, savePixivSettings } from './pixiv-auth.js';
import { resolveWithin } from './safe-path.js';
import type { BrowserLoginProvider, BrowserLoginSession } from '../../../shared/types.js';

export function browserLoginEnabled(): boolean {
  return Boolean(config.browserLogin.url && config.browserLogin.keyFile && config.browserLogin.publicUrl);
}
const sessionSchema = z.object({ id: z.string().uuid(), expiresAt: z.string().datetime(), launchToken: z.string().regex(/^[a-f0-9]{64}$/) });
const cookieSchema = z.object({ name: z.literal('PHPSESSID'), value: z.string().min(1).max(8192),
  domain: z.enum(['pixiv.net', '.pixiv.net', 'accounts.pixiv.net', '.accounts.pixiv.net']), path: z.string().startsWith('/').max(1024),
  secure: z.literal(true), httpOnly: z.boolean().optional(), sameSite: z.enum(['Strict', 'Lax', 'None']).optional(), expires: z.number().optional() });
const cookiesSchema = z.array(cookieSchema).max(8);
const cookiePath = () => resolveWithin(config.dataDir, 'pixiv-browser-cookies.json');
function readWebCookies() {
  try {
    if (fs.statSync(cookiePath()).size > 32768) return [];
    return cookiesSchema.parse(JSON.parse(fs.readFileSync(cookiePath(), 'utf8')))
      .filter(cookie => !cookie.expires || cookie.expires < 0 || cookie.expires * 1000 > Date.now());
  } catch { return []; }
}
function saveWebCookies(value: unknown) {
  if (value === undefined) return;
  const cookies = cookiesSchema.parse(value);
  const temporary = `${cookiePath()}.${randomUUID()}.tmp`;
  fs.mkdirSync(config.dataDir, { recursive: true });
  try { fs.writeFileSync(temporary, JSON.stringify(cookies), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, cookiePath()); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function clearPixivWebSession(): void { fs.rmSync(cookiePath(), { force: true }); }

class BrokerError extends Error { constructor(public status: number) { super('浏览器登录服务暂不可用'); } }
export class BrowserLogin {
  private active: BrowserLoginSession | undefined;
  private busy = false;
  private verifier = '';
  private poll: ReturnType<typeof setTimeout> | undefined;
  private failure = '';
  private captured = false;
  private pollErrors = 0;

  private async call(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    if (!browserLoginEnabled()) throw new Error('浏览器登录未启用');
    let key: string;
    try { key = fs.readFileSync(config.browserLogin.keyFile!, 'utf8').trim(); }
    catch { throw new Error('无法读取浏览器登录服务凭据'); }
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('浏览器登录服务凭据格式不正确');
    try {
      const response = await fetch(new URL(endpoint, config.browserLogin.url), {
        method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error',
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new BrokerError(response.status); }
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length; if (size > 32768) throw new Error(); chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new Error('无法连接浏览器登录服务');
    }
  }
  status(provider: BrowserLoginProvider = 'fanbox'): BrowserLoginSession | undefined {
    if (this.active && !this.active.completed && Date.parse(this.active.expiresAt) <= Date.now()) {
      this.active = undefined; clearTimeout(this.poll); this.verifier = '';
    }
    return this.active?.provider === provider ? this.active : undefined;
  }
  error(provider: BrowserLoginProvider): string | undefined { return this.active?.provider === provider ? this.failure || undefined : undefined; }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('登录会话正在处理，请稍后重试');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  start(provider: BrowserLoginProvider = 'fanbox', mobile = false): Promise<BrowserLoginSession> {
    return this.exclusive(async () => {
      if (provider === 'fanbox' && config.fanbox.cookiesFile) throw new Error('FANBOX 正在使用服务端 Cookie 文件');
      if (this.active?.completed) this.active = undefined;
      this.status(this.active?.provider);
      if (this.active) {
        if (this.active.provider !== provider) throw new Error('另一个来源正在登录，请先完成或取消');
        return this.active;
      }
      this.failure = ''; this.captured = false; this.pollErrors = 0;
      this.verifier = provider === 'pixiv' ? randomBytes(32).toString('base64url') : '';
      const loginUrl = provider === 'pixiv' ? new URL('https://app-api.pixiv.net/web/v1/login') : new URL('https://www.fanbox.cc/login');
      if (provider === 'pixiv') {
        loginUrl.search = new URLSearchParams({ code_challenge: createHash('sha256').update(this.verifier).digest('base64url'), code_challenge_method: 'S256', client: 'pixiv-android' }).toString();
      } else loginUrl.searchParams.set('return_to', 'https://www.fanbox.cc/user/settings');
      const session = sessionSchema.parse(await this.call('POST', '/sessions', { provider, mobile, url: loginUrl.href,
        proxyUrl: provider === 'pixiv' ? config.pixiv.proxyUrl || config.outboundProxyUrl : config.outboundProxyUrl,
        cookies: readWebCookies() }));
      const browserUrl = new URL('/open', config.browserLogin.publicUrl); browserUrl.hash = session.launchToken;
      this.active = { id: session.id, provider, expiresAt: session.expiresAt, browserUrl: browserUrl.href };
      this.schedulePoll(provider);
      return this.active;
    });
  }
  private schedulePoll(provider: BrowserLoginProvider) {
    clearTimeout(this.poll);
    this.poll = setTimeout(async () => {
      const session = this.status(provider);
      if (!session || session.completed || this.failure) return;
      if (!this.busy) {
        try { await this.complete(session.id, provider); this.pollErrors = 0; }
        catch (error) {
          if (error instanceof BrokerError && error.status === 409) this.pollErrors = 0;
          else if (++this.pollErrors >= 3) this.failure = `${provider === 'pixiv' ? 'Pixiv' : 'FANBOX'} 登录状态暂时无法确认，请点击「我已经登录」重试，或取消后重新登录`;
        }
      }
      if (!this.active?.completed && !this.failure) this.schedulePoll(provider);
    }, provider === 'fanbox' ? 2000 : 1000);
    this.poll.unref();
  }
  complete(id: string, provider: BrowserLoginProvider = 'fanbox'): Promise<void> {
    return this.exclusive(async () => {
      if (!this.status(provider) || this.active!.id !== id) throw new Error('登录会话已结束，请重新打开');
      if (this.active!.completed) return;
      if (!this.captured) {
        const raw = await this.call('POST', `/sessions/${id}/capture`);
        if (provider === 'pixiv') {
          const result = z.object({ code: z.string().min(1).max(2048), cookies: cookiesSchema.optional() }).parse(raw);
          const token = await exchangePixivCode(result.code, this.verifier);
          savePixivSettings(token); saveWebCookies(result.cookies); this.verifier = '';
        } else {
          const result = z.object({ sessionId: z.string().min(1).max(8192), cookies: cookiesSchema.optional() }).parse(raw);
          saveFanboxSettings(validateFanboxSession(result.sessionId)); saveWebCookies(result.cookies);
        }
        this.captured = true;
      }
      try { await this.call('DELETE', `/sessions/${id}`); }
      catch (error) { if (!(error instanceof BrokerError && error.status === 410)) throw error; }
      clearTimeout(this.poll);
      this.failure = ''; this.pollErrors = 0;
      this.active = { ...this.active!, completed: true, browserUrl: '' };
    });
  }
  cancel(id: string, provider: BrowserLoginProvider = 'fanbox'): Promise<void> {
    return this.exclusive(async () => {
      if (!this.active || this.active.id !== id || this.active.provider !== provider) throw new Error('登录会话已结束');
      if (!this.active.completed) {
        try { await this.call('DELETE', `/sessions/${id}`); }
        catch (error) { if (!(error instanceof BrokerError && error.status === 410)) throw error; }
      }
      this.active = undefined; this.verifier = ''; clearTimeout(this.poll);
    });
  }
  async close(): Promise<void> {
    clearTimeout(this.poll);
    if (this.active) await this.cancel(this.active.id, this.active.provider).catch(() => {});
  }
}
export const browserLogin = new BrowserLogin();
