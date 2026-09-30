import { Replicator } from './replication/replicator.js';
import { registerReplicationHooks } from './replication/http.js';
import { scheduleVerification, getVerification, resumeHistoricalVerification } from './services/content-verification.js';
import Fastify from 'fastify';
import { registerAuth } from './services/auth.js';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { backupDb, closeDb, getDbPath, initDb } from './db/connection.js';
import { registerPackRoutes } from './routes/packs.js';
import { registerPresetRoutes } from './routes/presets.js';
import { registerProcessingRoutes } from './routes/processing.js';
import { registerDownloadRoutes } from './routes/download.js';
import { registerSystemRoutes } from './routes/system.js';
import { tusPlugin } from './plugins/tus.js';
import { jobQueue } from './services/job-queue.js';
import {
  createJob,
  completePackFile,
  getPackFiles,
  getPendingPackFileCount,
  getLatestJob,
  hasActiveJob,
  listPacks,
  recoverInterruptedJobs,
  updatePackStatus,
  updatePackStats,
  updatePackStructureType,
} from './db/repositories.js';
import type { CompressionOptions, Job } from './types.js';
import {
  ensureDir,
  getArchivePath,
  getFolderStagingDir,
  getGeneratedPath,
  getUploadPath,
} from './services/storage.js';
import { folderProcessor } from './services/folder-processor.js';
import { resolveWithin } from './services/safe-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureRecoveryJob(
  packId: string,
  type: Job['type'],
  options?: CompressionOptions
): void {
  if (!hasActiveJob(packId, type)) {
    createJob(packId, type, options);
  }
}

function recoverCompletedFolderFiles(packId: string): number {
  const stagingDir = getFolderStagingDir(packId);
  let recovered = 0;

  for (const packFile of getPackFiles(packId)) {
    if (packFile.status === 'uploaded') continue;

    const destination = resolveWithin(stagingDir, packFile.relativePath, 'folder file path');
    let source: string | null = null;
    if (fs.existsSync(destination)) {
      source = destination;
    } else if (packFile.uploadId) {
      const uploadPath = getUploadPath(packFile.uploadId);
      if (fs.existsSync(uploadPath)) source = uploadPath;
    }
    if (!source) continue;

    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size !== packFile.fileSize) continue;
    if (source !== destination) {
      ensureDir(path.dirname(destination));
      fs.renameSync(source, destination);
    }
    completePackFile(packFile.id);
    if (packFile.uploadId) {
      fs.rmSync(`${getUploadPath(packFile.uploadId)}.info`, { force: true });
      fs.rmSync(`${getUploadPath(packFile.uploadId)}.json`, { force: true });
    }
    recovered++;
  }

  return recovered;
}

function recoverJobs(): void {
  const recovered = recoverInterruptedJobs();
  if (recovered > 0) {
    console.log(`[startup] Requeued ${recovered} interrupted job(s)`);
  }

  for (const pack of listPacks()) {
    const verification = getVerification(pack.id);
    if (verification?.historical && verification.status === 'pending' && ['extracted', 'generated', 'failed'].includes(pack.status)) {
      resumeHistoricalVerification(pack.id);
      continue;
    }
    if (pack.status === 'uploading' && pack.sourceType === 'archive') {
      try {
        const archivePath = getArchivePath(pack.id, `original.${pack.originalFormat}`);
        if (fs.existsSync(archivePath)) {
          ensureRecoveryJob(pack.id, 'extract');
        } else {
          updatePackStatus(pack.id, 'failed', '上传记录存在，但原始压缩包缺失');
        }
      } catch (error) {
        updatePackStatus(
          pack.id,
          'failed',
          `无法恢复上传任务：${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (pack.status === 'extracting') {
      ensureRecoveryJob(pack.id, 'extract');
    } else if (pack.status === 'verifying') {
      ensureRecoveryJob(pack.id, 'verify');
    } else if (pack.status === 'awaiting_confirmation') {
      // A browser must explicitly resume the upload confirmation.
      continue;
    } else if (pack.status === 'thumbnailing') {
      ensureRecoveryJob(pack.id, 'thumbnail');
    } else if (pack.status === 'generating') {
      if (!hasActiveJob(pack.id, 'compress')) {
        const latest = getLatestJob(pack.id, 'compress');
        try {
          if (!latest?.options) throw new Error('压缩参数缺失');
          ensureRecoveryJob(pack.id, 'compress', JSON.parse(latest.options));
        } catch (error) {
          updatePackStatus(
            pack.id,
            fs.existsSync(getGeneratedPath(pack.id)) ? 'generated' : 'extracted',
            `服务重启后无法恢复压缩参数：${error instanceof Error ? error.message : String(error)}`
          );
          resumeHistoricalVerification(pack.id);
        }
      }
    } else if (pack.status === 'uploading' && pack.sourceType === 'folder') {
      try {
        const recoveredFiles = recoverCompletedFolderFiles(pack.id);
        if (recoveredFiles > 0) {
          console.log(
            `[startup] Recovered ${recoveredFiles} completed folder upload(s) for pack ${pack.id}`
          );
        }
        if (getPendingPackFileCount(pack.id) === 0) {
          const result = folderProcessor.processUploadedFolder(pack.id);
          updatePackStats(pack.id, result);
          updatePackStructureType(pack.id, result.structureType);
          scheduleVerification(pack.id);
        } else {
          // Browser File objects cannot be reconstructed after a restart. Preserve
          // staged files for diagnosis or manual cleanup instead of deleting them.
          updatePackStatus(pack.id, 'failed', '上传中断（服务已重启，暂存文件已保留）');
        }
      } catch (error) {
        updatePackStatus(
          pack.id,
          'failed',
          `无法恢复文件夹上传：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}

function installShutdownHandlers(app: FastifyInstance, replicator?: Replicator): void {
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (signal: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      app.log.info({ signal }, 'Graceful shutdown started');
      const closePromise = app.close();
      await replicator?.stop();
      const drained = await jobQueue.shutdown(config.shutdownTimeout);

      if (!drained) {
        const interruptedJobId = jobQueue.getCurrentJobId();
        const { terminateArchiveProcesses } = await import('./services/archive-extractor.js');
        await terminateArchiveProcesses();
        await jobQueue.shutdown(2_500);
        jobQueue.requeueJob(interruptedJobId);
        app.log.warn(
          { timeoutMs: config.shutdownTimeout },
          'Shutdown timeout reached; child processes were terminated and the current job was requeued'
        );
        process.exit(1);
      }

      await closePromise;
      try {
        const backupPath = config.replicationRole === 'replica' ? null : await backupDb('shutdown');
        app.log.info({ backupPath }, 'Database backup completed');
      } catch (error) {
        app.log.error({ error }, 'Database backup during shutdown failed');
        exitCode = 1;
      }
      closeDb();
      process.exit(exitCode);
    })();

    return shutdownPromise;
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('uncaughtException', error => {
    app.log.fatal({ error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', reason => {
    app.log.fatal({ reason }, 'Unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });
}

async function main() {
  const app = Fastify({
    ...(config.tlsCertFile && config.tlsKeyFile ? { https: {
      cert: fs.readFileSync(config.tlsCertFile),
      key: fs.readFileSync(config.tlsKeyFile),
    } } : {}),
    disableRequestLogging: true,
    logger: {
      level: 'info',
      serializers: { req: request => ({ method: request.method, url: request.url?.split('?')[0] }) },
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
    bodyLimit: config.maxApiBodySize,
  });

  await app.register(cors, { origin: true, exposedHeaders: ['Location', 'Upload-Offset', 'Upload-Length', 'Tus-Resumable', 'Content-Disposition', 'ETag', 'X-AoI-Generation'], methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });

  app.get('/runtime-config.json', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { serverSelectionEnabled: config.serverSelectionEnabled };
  });
  app.get('/healthz', async () => ({ status: 'ok' }));

  let replicator: Replicator | undefined;
  if (!config.frontendOnly) {
    registerAuth(app);
    registerReplicationHooks(app);
    if (config.replicationRole !== 'replica') await app.register(tusPlugin);

    await initDb();
    app.log.info({ database: getDbPath(), dataDir: config.dataDir }, 'Database initialized');

    await app.register(registerPackRoutes);
    await app.register(registerPresetRoutes);
    await app.register(registerProcessingRoutes);
    await app.register(registerDownloadRoutes);
    await app.register(registerSystemRoutes);

    if (config.replicationRole !== 'replica') {
      recoverJobs();
      jobQueue.start();
    }
    if (config.replicationRole !== 'off') {
      replicator = new Replicator();
      await replicator.initialize();
      replicator.start();
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
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) res.header('Cache-Control', 'no-cache');
    },
  });

  // SPA fallback
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || path.extname(request.url.split('?')[0])) {
      reply.code(404).send({ error: 'Not Found' });
      return;
    }
    reply.sendFile('index.html');
  });

  if (!config.frontendOnly) {
    installShutdownHandlers(app, replicator);
  } else {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => void app.close().then(() => process.exit(0)));
    }
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Server listening on ${config.tlsCertFile ? 'https' : 'http'}://${config.host}:${config.port}`);
  process.send?.('ready');
}

main().catch(error => {
  console.error('[startup] Fatal error:', error);
  closeDb();
  process.exit(1);
});
