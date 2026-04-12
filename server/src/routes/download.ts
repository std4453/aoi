import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import { getGeneratedPath } from '../services/storage.js';
import { getPack } from '../db/repositories.js';
import { stat } from 'node:fs/promises';

export const registerDownloadRoutes: FastifyPluginAsync = async function (fastify) {
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id/download', async (request, reply) => {
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

    // RFC 5987: encode non-ASCII characters in Content-Disposition
    const encodedFileName = encodeURIComponent(fileName);
    const isAsciiOnly = fileName === encodedFileName;

    const range = request.headers.range;
    let start = 0;
    let end = fileStat.size - 1;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10);
      if (parts[1]) end = parseInt(parts[1], 10);
    }

    const chunkSize = end - start + 1;

    reply.raw.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': isAsciiOnly
        ? `attachment; filename="${fileName}"`
        : `attachment; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`,
      'Content-Length': chunkSize,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fileStat.size}` } : {}),
    });

    const stream = fs.createReadStream(archivePath, { start, end });
    stream.pipe(reply.raw);

    request.raw.on('close', () => stream.destroy());
  });
};
