import { get, post, put, del } from './client';
import type { Preset, CompressionOptions } from '../../../shared/types.js';

export function fetchPresets(): Promise<Preset[]> {
  return get<Preset[]>('/presets');
}

export function fetchDefaultPreset(): Promise<Preset | null> {
  return get<Preset | null>('/presets/default');
}

export function fetchPreset(id: string): Promise<Preset> {
  return get<Preset>(`/presets/${id}`);
}

export function createPreset(name: string, options: CompressionOptions, isDefault?: boolean): Promise<Preset> {
  return post<Preset>('/presets', { name, options, isDefault });
}

export function updatePreset(id: string, name: string, options: CompressionOptions): Promise<Preset> {
  return put<Preset>(`/presets/${id}`, { name, options });
}

export function removePreset(id: string): Promise<void> {
  return del<void>(`/presets/${id}`);
}

export function setDefaultPreset(id: string): Promise<void> {
  return post<void>(`/presets/${id}/set-default`, {});
}
