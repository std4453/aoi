import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { browserLogin, browserLoginEnabled } from '../services/browser-login.js';
import { readFanboxSettings } from '../services/fanbox-auth.js';
import { readPixivSettings } from '../services/pixiv-auth.js';
import type { BrowserLoginProvider } from '../../../shared/types.js';
import { config } from '../config/index.js';

export const registerBrowserLoginRoutes: FastifyPluginAsync = async app => {
  // With no AoI key, only same-origin loopback callers can control a browser.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!browserLoginEnabled()) return reply.code(404).send({ error: '浏览器登录未启用' });
    if (!config.authKey) {
      const host = request.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) return reply.code(403).send({ error: '仅允许本地访问' });
      if (request.headers.origin && request.headers.origin !== `${request.protocol}://${host}`) return reply.code(403).send({ error: '不允许跨站访问登录会话' });
      if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: '不允许跨站访问登录会话' });
    }
    if (request.method !== 'GET' && request.headers['x-aoi-browser-login'] !== '1') return reply.code(403).send({ error: '无效的登录会话请求' });
  });
  app.addHook('onClose', () => browserLogin.close());
  for (const provider of ['fanbox', 'pixiv'] as BrowserLoginProvider[]) {
    const base = `/api/settings/${provider}/browser-login`;
    app.get(base, async () => ({ session: browserLogin.status(provider) ?? null, error: browserLogin.error(provider) }));
    app.post(base, async (request, reply) => {
      const input = z.object({ mobile: z.boolean().optional() }).strict().safeParse(request.body ?? {});
      if (!input.success) return reply.code(400).send({ error: '无效的登录请求' });
      try { return await browserLogin.start(provider, input.data.mobile); }
      catch { return reply.code(409).send({ error: '无法启动浏览器登录，请检查登录服务或已有会话' }); }
    });
    app.post<{ Params: { id: string } }>(`${base}/:id/complete`, async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success) return reply.code(400).send({ error: '无效的会话编号' });
      try {
        await browserLogin.complete(request.params.id, provider);
        const value = provider === 'pixiv' ? readPixivSettings() : readFanboxSettings();
        return { configured: Boolean('refreshToken' in value ? value.refreshToken : value.sessionId), source: value.source, browserLoginEnabled: true };
      } catch { return reply.code(409).send({ error: '尚未完成官方登录，或授权保存失败，请稍后重试' }); }
    });
    app.delete<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success) return reply.code(400).send({ error: '无效的会话编号' });
      try { await browserLogin.cancel(request.params.id, provider); return { cancelled: true }; }
      catch { return reply.code(409).send({ error: '无法关闭登录会话，请稍后重试' }); }
    });
  }
};
