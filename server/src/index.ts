import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { initDb } from './db/connection.js';
import { registerPackRoutes } from './routes/packs.js';
import { registerPresetRoutes } from './routes/presets.js';
import { registerProcessingRoutes } from './routes/processing.js';
import { registerDownloadRoutes } from './routes/download.js';
import { registerSystemRoutes } from './routes/system.js';
import { tusPlugin } from './plugins/tus.js';
import { jobQueue } from './services/job-queue.js';
import { listPacks } from './db/repositories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
    bodyLimit: config.maxUploadSize,
  });

  await app.register(cors, { origin: true });
  await app.register(tusPlugin);

  await initDb();

  await app.register(registerPackRoutes);
  await app.register(registerPresetRoutes);
  await app.register(registerProcessingRoutes);
  await app.register(registerDownloadRoutes);
  await app.register(registerSystemRoutes);

  // Resume interrupted jobs: enqueue thumbnail for packs stuck in 'thumbnailing' (extraction done but thumbnails not yet generated)
  const packs = listPacks();
  for (const pack of packs) {
    if (pack.status === 'thumbnailing') {
      jobQueue.enqueue(pack.id, 'thumbnail');
    }
  }

  // Serve React static files in production
  // In dev: __dirname = server/src/ → ../public = server/public/
  // In prod: __dirname = server/dist/server/src/ → ../../../public = server/public/
  const publicDir = __dirname.includes(path.join('dist', 'server'))
    ? path.join(__dirname, '../../../public')
    : path.join(__dirname, '../public');
  app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) {
      reply.code(404).send({ error: 'Not Found' });
      return;
    }
    reply.sendFile('index.html');
  });

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
