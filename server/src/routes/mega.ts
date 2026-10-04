import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { describeMegaShare } from '~/services/mega-download';

export const registerMegaRoutes: FastifyPluginAsync = async app => {
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
