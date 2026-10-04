import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getFanboxClient, parseFanboxUrl } from '~/services/fanbox-client';
import { readFanboxSettings, saveFanboxSettings } from '~/services/fanbox-auth';
import { ensureImportTags } from '~/services/import-tags';
import { beginMutation } from '~/replication/state';
import { browserLoginEnabled } from '~/services/browser-login';
import type { FanboxMetadata, FanboxSettings } from '~/types';

export const registerFanboxRoutes: FastifyPluginAsync = async app => {
  app.get<{ Querystring: { reveal?: string } }>('/api/settings/fanbox', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { sessionId, source } = readFanboxSettings();
      return { configured: Boolean(sessionId), source, ...(request.query.reveal === '1' ? { sessionId } : {}), ...(browserLoginEnabled() ? { browserLoginEnabled: true } : {}) } satisfies FanboxSettings;
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.put('/api/settings/fanbox', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = z.object({ sessionId: z.string().max(8192) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: '无效的 FANBOX 登录配置' });
    try {
      saveFanboxSettings(input.data.sessionId);
      return { configured: Boolean(input.data.sessionId), source: input.data.sessionId ? 'settings' : 'none', ...(browserLoginEnabled() ? { browserLoginEnabled: true } : {}) } satisfies FanboxSettings;
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.post('/api/packs/fanbox-metadata', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = z.object({ url: z.string().max(2048) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: '无效的 FANBOX 帖子网址' });
    try {
      const { id } = parseFanboxUrl(input.data.url);
      const post = await getFanboxClient().post(id);
      if (!post.media.length) throw new Error('该 FANBOX 帖子没有可导入的图片或视频；文字、压缩包及外部嵌入链接会被跳过');
      const end = beginMutation();
      try {
        return { title: post.title, author: post.author, tags: ensureImportTags([post.author]),
          imageCount: post.media.filter(media => media.category === 'image').length,
          videoCount: post.media.filter(media => media.category === 'video').length,
          skippedCount: post.skippedCount,
        } satisfies FanboxMetadata;
      } finally { end(); }
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '无法识别 FANBOX 帖子' }); }
  });
};
