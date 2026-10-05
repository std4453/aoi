import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { loginMega, logoutMega, readMegaSettings } from '~/services/mega-auth';
import { describeMegaShare } from '~/services/mega-download';

export const registerMegaRoutes: FastifyPluginAsync = async app => {
  app.get('/api/settings/mega', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readMegaSettings();
  });
  app.post('/api/settings/mega/login', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = z.object({
      email: z.string().trim().email().max(254), password: z.string().min(1).max(1024),
      secondFactorCode: z.string().regex(/^\d{6}$/).optional(),
    }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: '请输入有效的 MEGA 邮箱、密码及二次验证码' });
    try { return await loginMega(input.data); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.delete('/api/settings/mega', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return await logoutMega(); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.post('/api/packs/mega-metadata', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const input = z.object({
        url: z.string().max(2048),
        sharePassword: z.string().max(1024).optional(),
      }).strict().parse(request.body);
      return await describeMegaShare(input);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法识别 MEGA 分享' });
    }
  });
};
