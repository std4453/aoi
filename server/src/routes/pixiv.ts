import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { createPack, createJob, getPack, getLatestJob, hasAnyActiveJob, setPackTags, toPublicPack, updatePackStatus } from '../db/repositories.js';
import { getLiveMatches, getVerification } from '../services/content-verification.js';
import { parsePixivUrl, getPixivClient, ensurePixivTags } from '../services/pixiv-importer.js';
import { readPixivSettings, savePixivSettings, refreshTokenSchema } from '../services/pixiv-auth.js';
import { beginMutation } from '../replication/state.js';
import { jobQueue } from '../services/job-queue.js';
import type { PixivImportRequest, PixivImportStatus, PixivMetadata, PixivSettings } from '../../../shared/types.js';

const requestSchema = z.object({
  url: z.string().max(2048),
  packName: z.string().trim().max(200).regex(/^[^\0\r\n]*$/).optional(),
  tagIds: z.array(z.string()).max(1000).optional(),
}).strict();

export const registerPixivRoutes: FastifyPluginAsync = async app => {
  app.get('/api/settings/pixiv', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { refreshToken, source } = readPixivSettings();
    return { configured: Boolean(refreshToken), source } satisfies PixivSettings;
  });
  app.put('/api/settings/pixiv', async (request, reply) => {
    const input = z.object({ refreshToken: refreshTokenSchema }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: '无效的 refresh-token' });
    savePixivSettings(input.data.refreshToken);
    return { configured: Boolean(input.data.refreshToken), source: input.data.refreshToken ? 'settings' : 'none' } satisfies PixivSettings;
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
      const pack = getDb().transaction(() => {
        const created = createPack({ name: input.packName || `Pixiv ${artwork.id}`,
          originalFilename: artwork.url, originalSize: 0, originalFormat: 'pixiv', sourceType: 'folder' });
        setPackTags(created.id, input.tagIds ?? []);
        const job = createJob(created.id, 'pixiv');
        getDb().prepare('UPDATE jobs SET options = ? WHERE id = ?').run(JSON.stringify({ autoName: !input.packName, autoTags: input.tagIds === undefined }), job.id);
        return getPack(created.id)!;
      })();
      jobQueue.start();
      return reply.code(202).send(toPublicPack(pack));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无效的 Pixiv 导入请求' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/packs/:id/pixiv-import', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack || pack.originalFormat !== 'pixiv') return reply.code(404).send({ error: 'Pixiv 图包不存在' });
    const job = getLatestJob(pack.id, 'pixiv');
    return { pack: toPublicPack(pack), matches: getLiveMatches(pack.id), progress: job ? jobQueue.getProgress(job.id) : null } satisfies PixivImportStatus;
  });

  app.post<{ Params: { id: string } }>('/api/packs/:id/pixiv-retry', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack || pack.originalFormat !== 'pixiv') return reply.code(404).send({ error: 'Pixiv 图包不存在' });
    const verification = getVerification(pack.id);
    if (pack.status !== 'failed' || hasAnyActiveJob(pack.id) || (verification && !(verification.status === 'completed' && verification.approved))) {
      return reply.code(409).send({ error: '当前状态无法重试下载；校验失败请使用重试校验' });
    }
    getDb().transaction(() => {
      updatePackStatus(pack.id, verification ? 'thumbnailing' : 'uploading');
      const options = getLatestJob(pack.id, 'pixiv')?.options;
      const job = createJob(pack.id, verification ? 'thumbnail' : 'pixiv');
      if (!verification && options) getDb().prepare('UPDATE jobs SET options = ? WHERE id = ?').run(options, job.id);
    })();
    jobQueue.start();
    return { ok: true };
  });
};
