import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { beginMutation } from './state.js';
import { getPack } from '../db/repositories.js';
import { replicaReady } from '../db/snapshot-repository.js';
import { replicationStatus } from './replicator.js';

export function registerReplicationHooks(app: FastifyInstance): void {
  if (!config.isReplica && config.snapshotEnabled) {
    app.addHook('onRoute', options => {
      const methods = Array.isArray(options.method) ? options.method : [options.method];
      if (methods.every(method => ['GET', 'HEAD', 'OPTIONS'].includes(method)) ||
          ![
            '/api/tags', '/api/tags/:id', '/api/packs/:id', '/api/packs/:id/tags',
            '/api/packs/upload-complete', '/api/packs/folder-create',
            '/api/packs/:id/folder-file-complete', '/api/packs/:id/folder-continue',
            '/api/packs/:id/retry-verification', '/api/packs/:id/cancel-upload',
            '/api/packs/:id/process',
            '/api/packs/pixiv-import',
            '/api/packs/:id/upload-task', '/api/packs/:id/upload-task/retry', '/api/packs/:id/upload-task/continue',
          ].includes(options.url)) return;
      const original = options.handler;
      options.handler = async function (request, reply) {
        const end = beginMutation();
        try { return await original.call(this, request, reply); } finally { end(); }
      };
    });
  }
  app.addHook('onRequest', (request, reply, done) => {
    const pathname = request.url.split('?')[0];
    if (!config.isReplica || !pathname.startsWith('/api/') || request.method === 'OPTIONS' ||
        ['/api/auth/login', '/api/health', '/api/system/replication'].includes(pathname)) return done();
    if (!['GET', 'HEAD'].includes(request.method)) {
      void reply.code(403).send({ code: 'READ_ONLY_REPLICA', error: '备服务器只读，无法执行写操作' }); return;
    }
    replicationStatus.ready ||= replicaReady();
    if (!replicationStatus.ready && pathname === '/api/packs') {
      void reply.code(503).send({ code: 'REPLICA_NOT_READY', error: '备服务器正在等待首次同步' }); return;
    }
    const id = (request.params as { id?: string })?.id;
    const pack = id ? getPack(id) : undefined;
    if (pack && !['extracted', 'generated'].includes(pack.status) &&
        /^\/api\/packs\/[^/]+\/(images|videos|ugoira|thumbnails|cover|file-tree)(?:\/|$)/.test(pathname)) {
      void reply.code(409).send({ code: 'PACK_PROCESSING', error: '图包正在处理，请稍后刷新' }); return;
    }
    done();
  });
  app.get('/api/system/replication', async () => {
    if (config.isReplica) replicationStatus.ready ||= replicaReady();
    return { ...replicationStatus };
  });
}
