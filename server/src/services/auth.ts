import { protocolVersion } from '../version.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';

// A process-scoped credential keeps the configured key out of resource URLs.
// Restarting the service invalidates it; clients reauthenticate with their saved key.
const token = randomBytes(32).toString('hex');
function matches(value: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(expected).digest());
}

export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'OPTIONS' || !url.pathname.startsWith('/api/') ||
        url.pathname === '/api/health' || url.pathname === '/api/auth/login') return;
    reply.header('Cache-Control', 'no-store');
    if (!config.authKey) return;
    const bearer = request.headers.authorization?.replace(/^Bearer /, '') || '';
    // Query credentials are accepted only for read-only browser resources/SSE.
    const resource = /^\/api\/(packs\/[^/]+\/(cover|images\/.*|videos\/.*|ugoira\/.*|thumbnails\/.*|download)|jobs\/[^/]+\/events)$/.test(url.pathname);
    const credential = bearer || (['GET', 'HEAD'].includes(request.method) && resource ? url.searchParams.get('access_token') || '' : '');
    if (!matches(credential, token)) return reply.code(401).send({ error: 'Key 无效或登录已失效', code: 'UNAUTHORIZED' });
  });
  app.get('/api/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', service: 'aoi', authRequired: Boolean(config.authKey), writable: !config.isReplica, role: config.isReplica ? 'replica' : 'standalone', capabilities: { generatedArchiveDownload: !config.isReplica, snapshots: !config.isReplica && config.snapshotEnabled }, replicationProtocol: protocolVersion };
  });
  app.post<{ Body: { key?: string } }>('/api/auth/login', {
    schema: { body: { type: 'object', properties: { key: { type: 'string', maxLength: 4096 } }, additionalProperties: false } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (config.authKey && !matches(request.body.key || '', config.authKey)) {
      return reply.code(401).send({ error: 'Key 不正确', code: 'UNAUTHORIZED' });
    }
    return { token: config.authKey ? token : '' };
  });
}
