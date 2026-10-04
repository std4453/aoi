import { get, post, put } from './client';
import type { FanboxMetadata, FanboxSettings } from '../../../shared/types';

export const fetchFanboxMetadata = (url: string) => post<FanboxMetadata>('/packs/fanbox-metadata', { url });
export const fetchFanboxSettings = (reveal = false) => get<FanboxSettings>(`/settings/fanbox${reveal ? '?reveal=1' : ''}`);
export const updateFanboxSettings = (sessionId: string) => put<FanboxSettings>('/settings/fanbox', { sessionId });
