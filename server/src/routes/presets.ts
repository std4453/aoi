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
  }>('/api/presets/:id', async (request) => {
    const preset = getPreset(request.params.id);
    if (!preset) {
      return { error: 'Preset not found' };
    }
    return preset;
  });

  // Create preset
  fastify.post<{
    Body: { name: string; options: CompressionOptions; isDefault?: boolean };
  }>('/api/presets', async (request) => {
    const { name, options, isDefault } = request.body;
    return createPreset(name, options, isDefault);
  });

  // Update preset
  fastify.put<{
    Params: { id: string };
    Body: { name: string; options: CompressionOptions };
  }>('/api/presets/:id', async (request) => {
    const { name, options } = request.body;
    return updatePreset(request.params.id, name, options);
  });

  // Delete preset
  fastify.delete<{
    Params: { id: string };
  }>('/api/presets/:id', async (request) => {
    deletePresetFromDb(request.params.id);
    return { ok: true };
  });

  // Set default preset
  fastify.post<{
    Params: { id: string };
    Body: Record<string, never>;
  }>('/api/presets/:id/set-default', async (request) => {
    setDefaultPreset(request.params.id);
    return { ok: true };
  });
};
