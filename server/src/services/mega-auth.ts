import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Storage } from '@std4453/megajs';
import { z } from 'zod';
import { config } from '~/config';
import { TaskError } from '~/task-errors';
import type { MegaLoginInput, MegaSettings } from '~/types';
import { createMegaConnection } from './mega-connection';
import { taskErrorCode } from './task-errors';

const sessionSchema = z.object({ sid: z.string().regex(/^[\w-]{58}$/), expired: z.boolean().optional() }).strict();
type Session = z.infer<typeof sessionSchema>;
const settingsPath = () => path.join(config.dataDir, 'mega-settings.json');

function loadSession(): Session | null {
  try {
    if (fs.statSync(settingsPath()).size > 1024) throw new TaskError('AUTH_REQUIRED', 'MEGA 登录配置无效');
    const value: unknown = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return value === null ? null : sessionSchema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new TaskError('AUTH_REQUIRED', '无法读取 MEGA 登录配置，请重新登录');
  }
}

export function readMegaSession(): Session | null {
  const session = loadSession();
  if (session?.expired) throw new TaskError('AUTH_REQUIRED', 'MEGA 登录已失效，请重新登录');
  return session;
}

export function readMegaSettings(): MegaSettings {
  try {
    const session = loadSession();
    return { configured: Boolean(session), expired: Boolean(session?.expired) };
  } catch { return { configured: true, expired: true }; }
}

function saveSession(session: Session | null): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const temporary = `${settingsPath()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, settingsPath());
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** A late failure must not expire a newer login or undo an explicit logout. */
export function expireMegaSession(sid: string): void {
  const current = loadSession();
  if (current?.sid === sid) saveSession({ ...current, expired: true });
}

let changing = false;
export async function loginMega(input: MegaLoginInput): Promise<MegaSettings> {
  if (changing) throw new TaskError('RATE_LIMITED', 'MEGA 登录正在进行，请稍后重试');
  const connection = createMegaConnection(AbortSignal.timeout(90_000));
  const storage = new Storage({ ...input, autoload: false, autologin: false, keepalive: false });
  storage.api = connection.api;
  changing = true;
  try {
    // No cloud tree or polling. Only us0/us/ug are needed to establish a session.
    await storage.ready;
    await connection.run(() => storage.login());
    saveSession(sessionSchema.parse({ sid: storage.sid }));
    return readMegaSettings();
  } catch (error) {
    if (error instanceof TaskError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/^EMFAREQUIRED /.test(message)) throw new TaskError('AUTH_REQUIRED', '请输入 MEGA 二次验证码');
    if (/^(ENOENT|EACCESS|EKEY) /.test(message)) throw new TaskError('AUTH_REQUIRED', 'MEGA 邮箱、密码或验证码不正确');
    if (/^(ETOOMANY|ERATELIMIT|EAGAIN) /.test(message)) throw new TaskError('RATE_LIMITED', 'MEGA 登录请求过于频繁，请稍后重试');
    if (/^EBLOCKED /.test(message)) throw new TaskError('ACCESS_DENIED', 'MEGA 账号已被限制');
    throw new TaskError(taskErrorCode(error, 'PROCESSING_FAILED'), 'MEGA 登录失败，请检查账号及代理连接后重试');
  } finally {
    // Do not serialize Storage: toJSON includes account keys, options and MFA.
    delete (storage.options as Partial<typeof storage.options>).password;
    delete storage.options.secondFactorCode;
    changing = false;
    await connection.close();
  }
}

export async function logoutMega(): Promise<MegaSettings> {
  if (changing) throw new TaskError('RATE_LIMITED', 'MEGA 登录正在进行，请稍后重试');
  changing = true;
  try {
    let session: Session | null = null;
    try { session = loadSession(); } catch { /* A damaged local setting can still be cleared. */ }
    if (session && !session.expired) {
      const connection = createMegaConnection(AbortSignal.timeout(15_000));
      connection.api.sid = session.sid;
      try { await connection.run(() => connection.api.request({ a: 'sml' })); }
      catch (error) {
        if (error instanceof TaskError) throw error;
        if (!(error instanceof Error && /^ESID /.test(error.message))) {
          throw new TaskError(taskErrorCode(error, 'PROCESSING_FAILED'), '无法撤销 MEGA 会话，请检查网络后重试');
        }
      } finally { await connection.close(); }
    }
    saveSession(null);
    return readMegaSettings();
  } finally { changing = false; }
}
