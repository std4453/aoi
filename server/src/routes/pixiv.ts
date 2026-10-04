import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getPack, toPublicPack } from '../db/repositories.js';
import { parsePixivUrl, getPixivClient, ensurePixivTags } from '../services/pixiv-importer.js';
import { readPixivSettings, savePixivSettings, refreshTokenSchema } from '../services/pixiv-auth.js';
import { browserLoginEnabled, clearPixivWebSession } from '../services/browser-login.js';
import { beginMutation } from '../replication/state.js';
import { createPixivUploadTask } from '../services/upload-tasks.js';
import type { PixivImportRequest, PixivMetadata, PixivSettings } from '../../../shared/types.js';

const requestSchema = z.object({
  url: z.string().max(2048),
  packName: z.string().trim().max(200).regex(/^[^\0\r\n]*$/).optional(),
  tagIds: z.array(z.string()).max(1000).optional(),
}).strict();

export const registerPixivRoutes: FastifyPluginAsync = async app => {
  app.get<{ Querystring: { reveal?: string } }>('/api/settings/pixiv', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { refreshToken, source } = readPixivSettings();
    return { configured: Boolean(refreshToken), source, ...(browserLoginEnabled() ? { browserLoginEnabled: true } : {}),
      ...(request.query.reveal === '1' ? { refreshToken } : {}),
    } satisfies PixivSettings;
  });
  app.put('/api/settings/pixiv', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = z.object({ refreshToken: refreshTokenSchema }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: '无效的 refresh-token' });
    savePixivSettings(input.data.refreshToken);
    if (!input.data.refreshToken) clearPixivWebSession();
    return { configured: Boolean(input.data.refreshToken), source: input.data.refreshToken ? 'settings' : 'none', ...(browserLoginEnabled() ? { browserLoginEnabled: true } : {}) } satisfies PixivSettings;
  });
  app.post('/api/packs/pixiv-metadata', async (request, reply) => {
    try {
      const input = z.object({ url: z.string().max(2048) }).strict().parse(request.body);
      const { id } = parsePixivUrl(input.url);
      const { metadata } = await getPixivClient().describe(id);
      const end = beginMutation();
      try {
        return { title: metadata.title.replace(/[\0\r\n]/g, ' ').slice(0, 200), author: metadata.userName,
          tags: ensurePixivTags([metadata.userName]), mediaType: metadata.illustType === 2 ? 'ugoira' : 'image' } satisfies PixivMetadata;
      } finally { end(); }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法识别 Pixiv 作品' });
    }
  });
  app.post<{ Body: PixivImportRequest }>('/api/packs/pixiv-import', async (request, reply) => {
    try {
      const input = requestSchema.parse(request.body);
      const artwork = parsePixivUrl(input.url);
      const task = createPixivUploadTask({ source: 'pixiv', name: input.packName || `Pixiv ${artwork.id}`,
        autoName: !input.packName, url: artwork.url, tagIds: input.tagIds });
      const pack = getPack(task.packId!)!;
      return reply.code(202).send(toPublicPack(pack));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无效的 Pixiv 导入请求' });
    }
  });
};
