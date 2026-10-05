import { TaskError } from '~/task-errors';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '~/config';
import { resolveWithin } from './safe-path';
import type { FanboxSettings } from '~/types';

export function validateFanboxSession(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_%=.~-]*$/.test(value)) {
    throw new Error('无效的 FANBOXSESSID，请只粘贴 Cookie 的值');
  }
  return value;
}

const settingsPath = () => resolveWithin(config.dataDir, 'fanbox-settings.json');

function readBoundedFile(filename: string): string {
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 1024 * 1024) throw new Error();
    return buffer.subarray(0, size).toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Only the FANBOX session for the API is selected; unrelated browser cookies are never sent. */
export function sessionFromCookieFile(text: string, now = Date.now()): string {
  const sessions = new Set<string>();
  for (const original of text.split(/\r?\n/)) {
    const line = original.replace(/^#HttpOnly_/, '');
    if (!line || line.startsWith('#')) continue;
    const [domain, subdomains, cookiePath, secure, expires, name, value, ...extra] = line.split('\t');
    if (name !== 'FANBOXSESSID') continue;
    const apiDomain = domain === 'api.fanbox.cc' || domain === '.api.fanbox.cc' ||
      (['fanbox.cc', '.fanbox.cc'].includes(domain) && subdomains === 'TRUE');
    if (!apiDomain || cookiePath !== '/' || !['TRUE', 'FALSE'].includes(secure) || extra.length ||
        !/^\d+$/.test(expires) || (Number(expires) !== 0 && Number(expires) * 1000 <= now)) continue;
    if (value) sessions.add(validateFanboxSession(value));
  }
  if (sessions.size !== 1) throw new TaskError('AUTH_REQUIRED', 'Cookie 文件中缺少有效且唯一的 FANBOXSESSID，请从已登录的浏览器重新导出');
  return [...sessions][0];
}

export function readFanboxSettings(): { sessionId: string; source: FanboxSettings['source'] } {
  if (config.fanbox.cookiesFile) {
    try { return { sessionId: sessionFromCookieFile(readBoundedFile(config.fanbox.cookiesFile)), source: 'cookie_file' }; }
    catch { throw new TaskError('AUTH_REQUIRED', '无法读取有效的 FANBOX Cookie 文件，请检查文件内容、有效期和权限'); }
  }
  try {
    const saved = JSON.parse(readBoundedFile(settingsPath())) as { sessionId?: unknown };
    const sessionId = validateFanboxSession(saved.sessionId);
    return { sessionId, source: sessionId ? 'settings' : 'none' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TaskError('AUTH_REQUIRED', '无法读取 FANBOX 登录配置');
    const sessionId = validateFanboxSession(config.fanbox.sessionId);
    return { sessionId, source: sessionId ? 'environment' : 'none' };
  }
}

export function saveFanboxSettings(sessionId: string): void {
  if (config.fanbox.cookiesFile) throw new Error('FANBOX 正在使用服务端 Cookie 文件，请更新该文件');
  const value = validateFanboxSession(sessionId);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const temporary = `${settingsPath()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ sessionId: value }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, settingsPath());
  } catch { throw new Error('无法保存 FANBOX 登录配置'); }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** Accept rotation only from the fixed API origin; never overwrite a newer user-supplied credential. */
export function rotateFanboxSession(previous: string, cookies: string[]): void {
  for (const cookie of cookies) {
    const [pair, ...attributes] = cookie.split(';').map(value => value.trim());
    if (!pair.startsWith('FANBOXSESSID=')) continue;
    const values = new Map(attributes.map(attribute => {
      const separator = attribute.indexOf('=');
      return separator < 0 ? [attribute.toLowerCase(), ''] : [attribute.slice(0, separator).toLowerCase(), attribute.slice(separator + 1)];
    }));
    if (values.has('domain') && !['fanbox.cc', '.fanbox.cc', 'api.fanbox.cc', '.api.fanbox.cc'].includes(values.get('domain')!.toLowerCase())) continue;
    if (values.has('path') && values.get('path') !== '/') continue;
    if (values.has('max-age') && (!/^\d+$/.test(values.get('max-age')!) || Number(values.get('max-age')) <= 0)) continue;
    if (!values.has('max-age') && values.has('expires') && !(Date.parse(values.get('expires')!) > Date.now())) continue;
    const next = pair.slice('FANBOXSESSID='.length);
    try { validateFanboxSession(next); } catch { continue; }
    if (!next || next === previous) continue;
    const current = readFanboxSettings();
    if (current.source !== 'cookie_file' && current.sessionId === previous) saveFanboxSettings(next);
  }
}
