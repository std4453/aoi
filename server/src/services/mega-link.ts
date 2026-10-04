import { TaskError } from '../../../shared/task-errors';
import { createHmac, pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(pbkdf2);

export class MegaPasswordError extends TaskError {
  constructor(message: string, code: 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT' = 'PASSWORD_REQUIRED') { super(code, message); }
  override name = 'MegaPasswordError';
}

/** Validate before any network request; public shares do not require a MEGA account. */
export function validateMegaUrl(input: string): URL {
  if (typeof input !== 'string' || input.length > 2_048) throw new Error('无效的 MEGA 分享链接');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('无效的 MEGA 分享链接'); }
  if (url.protocol !== 'https:' || !['mega.nz', 'mega.co.nz'].includes(url.hostname) ||
    url.username || url.password || url.port || url.search) throw new Error('请输入 HTTPS MEGA 公开分享链接');
  const modern = /^\/(?:file|folder)\/[\w-]{8}\/?$/.test(url.pathname) &&
    /^(?:|#[\w-]+(?:\/(?:file|folder)\/[\w-]{8})?)$/.test(url.hash);
  const legacy = url.pathname === '/' && /^#(?:P![\w-]+|(?:F)?![\w-]{8}(?:![\w-]+)?(?:![\w-]{8})?)$/.test(url.hash);
  if (!modern && !legacy) throw new Error('仅支持 MEGA 文件、文件夹或密码保护分享链接');
  return url;
}

/** Password link format follows meganz/webclient js/ui/export.js (algorithms 0–2). */
export async function resolveMegaUrl(input: string, password?: string): Promise<string> {
  const url = validateMegaUrl(input);
  if (url.hash.startsWith('#P!')) {
    const payload = Buffer.from(url.hash.slice(3), 'base64url');
    const algorithm = payload[0];
    const type = payload[1];
    const keyLength = type === 0 ? 16 : 32;
    if (![0, 1, 2].includes(algorithm) || ![0, 1].includes(type) || payload.length !== 72 + keyLength) {
      throw new Error('不支持或损坏的 MEGA 密码保护链接');
    }
    if (!password?.trim()) throw new MegaPasswordError('此 MEGA 分享需要分享密码');
    if (password.length > 1_024) throw new Error('分享密码过长');
    const derived = await deriveKey(password.trim(), payload.subarray(8, 40), algorithm === 0 ? 1_000 : 100_000, 64, 'sha512');
    const body = payload.subarray(0, -32);
    const macKey = derived.subarray(32);
    const mac = algorithm === 1
      ? createHmac('sha256', body).update(macKey).digest()
      : createHmac('sha256', macKey).update(body).digest();
    if (!timingSafeEqual(mac, payload.subarray(-32))) throw new MegaPasswordError('分享密码错误或链接已损坏', 'PASSWORD_INCORRECT');
    const key = Buffer.from(payload.subarray(40, 40 + keyLength));
    for (let i = 0; i < key.length; i++) key[i] ^= derived[i];
    return `https://mega.nz/${type === 0 ? 'folder' : 'file'}/${payload.subarray(2, 8).toString('base64url')}#${key.toString('base64url')}`;
  }
  const legacy = url.pathname === '/';
  const parts = legacy ? url.hash.split('!') : url.hash.slice(1).split('/');
  const folder = legacy ? parts[0] === '#F' : url.pathname.startsWith('/folder/');
  const handle = legacy ? parts[1] : url.pathname.split('/')[2];
  const key = password?.trim() || (legacy ? parts[2] : parts[0]);
  if (!key) throw new MegaPasswordError('此分享缺少解密密钥，请输入分享方提供的密钥');
  if (!/^[\w-]+$/.test(key) || Buffer.from(key, 'base64url').length !== (folder ? 16 : 32)) {
    throw new MegaPasswordError('MEGA 解密密钥格式错误', 'PASSWORD_INCORRECT');
  }
  const child = legacy ? parts[3] : parts[2];
  return `https://mega.nz/${folder ? 'folder' : 'file'}/${handle}#${key}${child ? `/file/${child}` : ''}`;
}
