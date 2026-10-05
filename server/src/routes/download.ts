import { config } from '~/config';
import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import { getGeneratedPath } from '~/services/storage';
import { getPack } from '~/db/repositories';
import { stat } from 'node:fs/promises';

import { parseRange } from '~/services/file-range';

export const registerDownloadRoutes: FastifyPluginAsync = async function (fastify) {
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id/download', async (request, reply) => {
    if (config.isReplica) return reply.code(404).send({ error: 'Generated archives are unavailable on replicas' });
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }

    const archivePath = getGeneratedPath(pack.id);
    if (!fs.existsSync(archivePath)) {
      reply.code(404).send({ error: 'Archive not yet generated' });
      return;
    }

    const fileStat = await stat(archivePath);
    const fileName = `${pack.name}-compressed.zip`;
    const encodedFileName = encodeURIComponent(fileName)
      .replace(/[!'()*]/g, character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      );

    const etag = `"${`${fileStat.size}-${fileStat.mtimeMs}`}-${pack.id}"`;
    const range = !request.headers['if-range'] || request.headers['if-range'] === etag ? request.headers.range : undefined;
    let start = 0;
    let end = fileStat.size - 1;

    if (range) {
      const parsed = parseRange(range, fileStat.size);
      if (!parsed) {
        reply
          .code(416)
          .header('Content-Range', `bytes */${fileStat.size}`)
          .send({ error: 'Invalid byte range' });
        return;
      }
      ({ start, end } = parsed);
    }

    const chunkSize = end - start + 1;

    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/zip',
      ETag: etag,
      'Content-Disposition': `attachment; filename="aoi-compressed.zip"; filename*=UTF-8''${encodedFileName}`,
      'Content-Length': chunkSize,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fileStat.size}` } : {}),
    });

    const stream = fs.createReadStream(archivePath, { start, end });
    stream.once('error', error => reply.raw.destroy(error));
    stream.pipe(reply.raw);

    reply.raw.once('close', () => stream.destroy());
  });
};
