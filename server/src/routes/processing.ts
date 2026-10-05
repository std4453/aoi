import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import {
  getDefaultPreset,
  getPack,
  getPreset,
  hasActiveJob,
} from '~/db/repositories';
import { jobQueue } from '~/services/job-queue';
import { getGeneratedDir } from '~/services/storage';
import type { CompressionOptions, FileSelection } from '~/types';
import {
  formatValidationError,
  parseCompressionOptions,
  parseFileSelection,
} from '~/services/validation';

export const registerProcessingRoutes: FastifyPluginAsync = async function (fastify) {
  const activeEventStreams = new Set<import('node:http').ServerResponse>();

  fastify.addHook('preClose', async () => {
    for (const stream of activeEventStreams) {
      stream.end();
    }
    activeEventStreams.clear();
  });

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
    const body = request.body ?? {};
    if (body.presetId) {
      const preset = getPreset(body.presetId);
      if (!preset) {
        reply.code(404).send({ error: 'Preset not found' });
        return;
      }
      try {
        options = parseCompressionOptions(preset.options);
      } catch (error) {
        reply.code(400).send({ error: `Preset is invalid: ${formatValidationError(error)}` });
        return;
      }
    } else if (body.options) {
      try {
        options = parseCompressionOptions(body.options);
      } catch (error) {
        reply.code(400).send({ error: formatValidationError(error) });
        return;
      }
    } else {
      // Use default preset
      const defaultPreset = getDefaultPreset();
      if (!defaultPreset) {
        reply.code(400).send({ error: 'No default preset configured' });
        return;
      }
      try {
        options = parseCompressionOptions(defaultPreset.options);
      } catch (error) {
        reply.code(400).send({ error: `Default preset is invalid: ${formatValidationError(error)}` });
        return;
      }
    }

    let fileSelection: FileSelection | undefined;
    if (body.fileSelection) {
      try {
        fileSelection = parseFileSelection(body.fileSelection);
      } catch (error) {
        reply.code(400).send({ error: formatValidationError(error) });
        return;
      }
    }
    const outputFileCount = fileSelection
      ? fileSelection.images.length + (options.keepVideos ? fileSelection.videos.length : 0)
      : pack.imageCount + (options.keepVideos ? pack.videoCount : 0);
    if (outputFileCount === 0) {
      reply.code(400).send({ error: 'No files are selected for the generated archive' });
      return;
    }

    // Remove only the working directory. Keep the last successful archive until
    // its replacement has been generated and atomically renamed into place.
    if (hasActiveJob(pack.id, 'compress')) {
      reply.code(409).send({ error: 'A compression job is already active for this pack' });
      return;
    }
    const workDir = path.join(getGeneratedDir(pack.id), 'temp');
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    // Merge fileSelection into options for job persistence
    const jobOptions = fileSelection ? { ...options, fileSelection } : options;

    try {
      const job = await jobQueue.enqueueUnique(pack.id, 'compress', jobOptions);
      return { jobId: job.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(message.includes('already exists') ? 409 : 503).send({ error: message });
    }
  });

  // Get job status
  fastify.get<{
    Params: { id: string };
  }>('/api/jobs/:id', async (request, reply) => {
    const progress = jobQueue.getProgress(request.params.id);
    if (!progress) {
      reply.code(404).send({ error: 'Job not found' });
      return;
    }
    return progress;
  });

  // SSE endpoint for job progress
  fastify.get<{
    Params: { id: string };
  }>('/api/jobs/:id/events', async (request, reply) => {
    const jobId = request.params.id;
    const res = reply.raw;
    const initial = jobQueue.getProgress(jobId);
    if (!initial) {
      reply.code(404).send({ error: 'Job not found' });
      return;
    }

    reply.hijack();
    activeEventStreams.add(res);
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) res.setHeader(name, value);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // Listen for progress events
    const onProgress = (progress: any) => {
      if (progress.jobId === jobId) {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
        if (progress.status === 'completed' || progress.status === 'failed') {
          if (heartbeat) clearInterval(heartbeat);
          jobQueue.off('progress', onProgress);
          activeEventStreams.delete(res);
          res.end();
        }
      }
    };
    jobQueue.on('progress', onProgress);

    // Register the listener before sending the current state so a terminal
    // transition cannot be missed between the initial read and subscription.
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
    if (initial.status === 'completed' || initial.status === 'failed') {
      jobQueue.off('progress', onProgress);
      activeEventStreams.delete(res);
      res.end();
      return;
    }
    heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);

    request.raw.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      jobQueue.off('progress', onProgress);
      activeEventStreams.delete(res);
    });
  });
};
