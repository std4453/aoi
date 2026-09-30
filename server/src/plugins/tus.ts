import { beginMutation } from '../replication/state.js';
import fp from 'fastify-plugin';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { config } from '../config.js';
import { ensureDir } from '../services/storage.js';

export const tusPlugin = fp(async function (fastify) {
  ensureDir(config.dirs.uploads);

  const tusServer = new Server({
    path: '/api/upload/files',
    datastore: new FileStore({ directory: config.dirs.uploads }),
    maxSize: config.maxUploadSize,
    relativeLocation: true,
    respectForwardedHeaders: false,
  });

  // Intercept tus requests BEFORE Fastify body parsing via onRequest hook.
  // This completely bypasses content-type parsing which would break tus streaming.
  fastify.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0];
    if (pathname !== '/api/upload/files' && !pathname.startsWith('/api/upload/files/')) return;

    const req = request.raw;
    const res = reply.raw;

    reply.hijack();
    const end = config.replicationRole === 'primary' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? beginMutation() : () => {};
    try { await tusServer.handle(req, res); } finally { end(); }
  });
});
