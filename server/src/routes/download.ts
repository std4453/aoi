import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import { getGeneratedPath } from '../services/storage.js';
import { getPack } from '../db/repositories.js';
import { stat } from 'node:fs/promises';

function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

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
    const encodedFileName = encodeURIComponent(fileName)
      .replace(/[!'()*]/g, character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      );

    const range = request.headers.range;
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
