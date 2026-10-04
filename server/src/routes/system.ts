import type { FastifyPluginAsync } from 'fastify';
import { getDiskSpace, getTotalDataSize } from '~/services/storage';

export const registerSystemRoutes: FastifyPluginAsync = async function (fastify) {
  fastify.get('/api/system/disk-space', async () => {
    const [diskSpace, dataSize] = await Promise.all([getDiskSpace(), getTotalDataSize()]);
    return {
      disk: diskSpace,
      dataUsed: dataSize,
    };
  });

};
