import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { beginMutation, currentGeneration, readContext, releaseGeneration } from './state.js';
import { replicationStatus } from './replicator.js';

export function registerReplicationHooks(app: FastifyInstance): void {
  if (config.replicationRole === 'primary') {
    app.addHook('onRoute', options => {
      const methods = Array.isArray(options.method) ? options.method : [options.method];
      if (methods.every(method => ['GET', 'HEAD', 'OPTIONS'].includes(method)) || options.url === '/api/auth/login') return;
      const original = options.handler;
      options.handler = async function (request, reply) {
        const end = beginMutation();
        try { return await original.call(this, request, reply); }
        finally { end(); }
      };
    });
  }
  app.addHook('onRequest', (request, reply, done) => {
    const pathname = request.url.split('?')[0];
    if (!pathname.startsWith('/api/') || request.method === 'OPTIONS' ||
        pathname === '/api/auth/login' || pathname === '/api/health' || pathname === '/api/system/replication') {
      done();
      return;
    }
    const write = !['GET', 'HEAD'].includes(request.method);
    if (config.replicationRole === 'replica') {
      if (write) {
        void reply.code(403).send({ code: 'READ_ONLY_REPLICA', error: '备服务器只读，无法执行写操作' });
        return;
      }
      const generation = currentGeneration();
      if (!generation) {
        void reply.code(503).send({ code: 'REPLICA_NOT_READY', error: '备服务器正在等待首次同步' });
        return;
      }
      generation.readers++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseGeneration(generation);
      };
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
      reply.header('X-AoI-Generation', generation.id);
      readContext.run(generation, done);
      return;
    }
    done();
  });
  app.get('/api/system/replication', async () => ({ ...replicationStatus }));
}
