import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '~/config';
import { publisher } from '~/replication/replicator';
import { cachedManifest, cachedSignature } from '~/replication/snapshots';
import { canonicalJson, digest, safeContentFile } from '~/replication/protocol';
import { parseRange } from '~/services/file-range';

export const registerSnapshotRoutes: FastifyPluginAsync = async app => {
  if (config.isReplica || !config.snapshotEnabled) return;
  app.get('/api/packs/snapshot', async (request, reply) => {
    const index = publisher.index();
    const etag = `"${digest(index)}"`;
    reply.header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json').send(canonicalJson(index));
  });
  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>('/api/packs/:id/snapshot', async (request, reply) => {
    const entry = publisher.entry(request.params.id);
    if (!entry) return reply.code(404).send({ error: 'Pack not found' });
    const manifest = entry.state === 'ready' ? cachedManifest(entry.id) : undefined;
    if (!manifest || request.query.revision !== manifest.revision) return reply.code(409).send({ code: 'SNAPSHOT_CHANGED' });
    return manifest;
  });
  app.get<{ Params: { id: string; '*': string }; Querystring: { contentHash?: string } }>('/api/packs/:id/snapshot/files/*', async (request, reply) => {
    const entry = publisher.entry(request.params.id);
    const manifest = entry?.state === 'ready' ? cachedManifest(entry.id) : undefined;
    const file = manifest?.files.find(file => file.path === request.params['*']);
    if (!manifest || !file || request.query.contentHash !== manifest.contentHash) return reply.code(409).send({ code: 'SNAPSHOT_CHANGED' });
    let handle: fs.promises.FileHandle | undefined;
    try {
      const filename = await safeContentFile(path.join(config.dirs.extracted, manifest.metadata.id), file.path);
      handle = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (cachedSignature(manifest.metadata.id, file.path) !== `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`) throw new Error('File changed');
      const etag = `"${file.hash}"`;
      reply.header('ETag', etag).header('Accept-Ranges', 'bytes').type('application/octet-stream');
      const range = !request.headers['if-range'] || request.headers['if-range'] === etag ? request.headers.range : undefined;
      const parsed = range ? parseRange(range, stat.size) : undefined;
      if (range && !parsed) { await handle.close(); return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send(); }
      if (parsed) reply.code(206).header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${stat.size}`);
      reply.header('Content-Length', parsed ? parsed.end - parsed.start + 1 : stat.size);
      const stream = handle.createReadStream(parsed ?? {});
      reply.raw.once('close', () => stream.destroy());
      return reply.send(stream);
    } catch {
      await handle?.close(); return reply.code(409).send({ code: 'SNAPSHOT_CHANGED' });
    }
  });
};
