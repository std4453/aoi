import type { FastifyPluginAsync } from 'fastify';
import { getPack } from '../db/repositories.js';
import { jobQueue } from '../services/job-queue.js';
import { getGeneratedPath, getGeneratedDir } from '../services/storage.js';
import type { CompressionOptions, FileSelection } from '../types.js';

export const registerProcessingRoutes: FastifyPluginAsync = async function (fastify) {
  // Start compression job
  fastify.post<{
    Params: { id: string };
    Body: { presetId?: string; options?: CompressionOptions; fileSelection?: FileSelection };
  }>('/api/packs/:id/process', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    if (pack.status !== 'extracted' && pack.status !== 'generated') {
      reply.code(400).send({ error: `Pack status is '${pack.status}', expected 'extracted' or 'generated'` });
      return;
    }

    let options: CompressionOptions;
    if (request.body.presetId) {
      const { getPreset } = await import('../db/repositories.js');
      const preset = getPreset(request.body.presetId);
      if (!preset) {
        reply.code(404).send({ error: 'Preset not found' });
        return;
      }
      options = preset.options;
    } else if (request.body.options) {
      options = request.body.options;
    } else {
      // Use default preset
      const { getDefaultPreset } = await import('../db/repositories.js');
      const defaultPreset = getDefaultPreset();
      if (!defaultPreset) {
        reply.code(400).send({ error: 'No default preset configured' });
        return;
      }
      options = defaultPreset.options;
    }

    // Clean up previous generated files
    const { rmSync, existsSync } = await import('node:fs');
    const genDir = getGeneratedDir(pack.id);
    if (existsSync(genDir)) {
      rmSync(genDir, { recursive: true, force: true });
    }

    // Merge fileSelection into options for job persistence
    if (request.body.fileSelection) {
      (options as any).fileSelection = request.body.fileSelection;
    }

    const job = await jobQueue.enqueue(pack.id, 'compress', options);
    return { jobId: job.id };
  });

  // Get job status
  fastify.get<{
    Params: { id: string };
  }>('/api/jobs/:id', async (request) => {
    const progress = jobQueue.getProgress(request.params.id);
    if (!progress) {
      return { error: 'Job not found' };
    }
    return progress;
  });

  // SSE endpoint for job progress
  fastify.get<{
    Params: { id: string };
  }>('/api/jobs/:id/events', async (request, reply) => {
    const jobId = request.params.id;
    const res = reply.raw;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial state
    const initial = jobQueue.getProgress(jobId);
    res.write(`data: ${JSON.stringify(initial)}\n\n`);

    // Listen for progress events
    const onProgress = (progress: any) => {
      if (progress.jobId === jobId) {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
        if (progress.status === 'completed' || progress.status === 'failed') {
          res.end();
        }
      }
    };
    jobQueue.on('progress', onProgress);

    request.raw.on('close', () => {
      jobQueue.off('progress', onProgress);
    });
  });
};
