import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { beginMutation, getActiveVersion, pinVersion, readContext } from './state.js';
import { replicationStatus } from './replicator.js';

export function registerReplicationHooks(app: FastifyInstance): void {
  if (!config.isReplica && config.snapshotEnabled) {
    app.addHook('onRoute', options => {
      const methods = Array.isArray(options.method) ? options.method : [options.method];
      if (methods.every(method => ['GET', 'HEAD', 'OPTIONS'].includes(method)) || options.url === '/api/auth/login') return;
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
    if (!replicationStatus.ready) {
      void reply.code(503).send({ code: 'REPLICA_NOT_READY', error: '备服务器正在等待首次同步' }); return;
    }
    const id = (request.params as { id?: string })?.id;
    const version = id ? getActiveVersion(id) : undefined;
    if (!version) return done();
    const release = pinVersion(version);
    reply.raw.once('finish', release); reply.raw.once('close', release);
    reply.header('X-AoI-Generation', version.id);
    readContext.run(version, done);
  });
  app.get('/api/system/replication', async () => ({ ...replicationStatus }));
}
