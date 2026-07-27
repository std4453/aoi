import type { FastifyPluginAsync } from 'fastify';
import {
  listPresets,
  getPreset,
  createPreset,
  updatePreset,
  deletePreset as deletePresetFromDb,
  setDefaultPreset,
  getDefaultPreset,
} from '../db/repositories.js';
import type { CompressionOptions } from '../types.js';
import { formatValidationError, parseCompressionOptions } from '../services/validation.js';

export const registerPresetRoutes: FastifyPluginAsync = async function (fastify) {
  // List presets
  fastify.get('/api/presets', async () => {
    return listPresets();
  });

  // Get default preset
  fastify.get('/api/presets/default', async () => {
    return getDefaultPreset() ?? null;
  });

  // Get single preset
  fastify.get<{
    Params: { id: string };
  }>('/api/presets/:id', async (request, reply) => {
    const preset = getPreset(request.params.id);
    if (!preset) {
      reply.code(404).send({ error: 'Preset not found' });
      return;
    }
    return preset;
  });

  // Create preset
  fastify.post<{
    Body: { name: string; options: CompressionOptions; isDefault?: boolean };
  }>('/api/presets', async (request, reply) => {
    const { name, options, isDefault } = request.body ?? {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName || trimmedName.length > 100) {
      reply.code(400).send({ error: 'Preset name must contain 1-100 characters' });
      return;
    }
    if (isDefault !== undefined && typeof isDefault !== 'boolean') {
      reply.code(400).send({ error: 'isDefault must be a boolean' });
      return;
    }
    try {
      return createPreset(trimmedName, parseCompressionOptions(options), isDefault);
    } catch (error) {
      reply.code(400).send({ error: formatValidationError(error) });
    }
  });

  // Update preset
  fastify.put<{
    Params: { id: string };
    Body: { name: string; options: CompressionOptions };
  }>('/api/presets/:id', async (request, reply) => {
    if (!getPreset(request.params.id)) {
      reply.code(404).send({ error: 'Preset not found' });
      return;
    }
    const { name, options } = request.body ?? {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName || trimmedName.length > 100) {
      reply.code(400).send({ error: 'Preset name must contain 1-100 characters' });
      return;
    }
    try {
      return updatePreset(request.params.id, trimmedName, parseCompressionOptions(options));
    } catch (error) {
      reply.code(400).send({ error: formatValidationError(error) });
    }
  });

  // Delete preset
  fastify.delete<{
    Params: { id: string };
  }>('/api/presets/:id', async (request, reply) => {
    const preset = getPreset(request.params.id);
    if (!preset) {
      reply.code(404).send({ error: 'Preset not found' });
      return;
    }
    if (preset.isDefault) {
      reply.code(409).send({ error: 'Default preset cannot be deleted' });
      return;
    }
    deletePresetFromDb(preset.id);
    return { ok: true };
  });

  // Set default preset
  fastify.post<{
    Params: { id: string };
    Body: Record<string, never>;
  }>('/api/presets/:id/set-default', async (request, reply) => {
    if (!getPreset(request.params.id)) {
      reply.code(404).send({ error: 'Preset not found' });
      return;
    }
    setDefaultPreset(request.params.id);
    return { ok: true };
  });
};
