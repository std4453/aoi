import { get, post, put } from './client';
import type { Pack, PixivImportRequest, PixivMetadata, PixivSettings } from '../../../shared/types';

export const startPixivImport = (input: PixivImportRequest) => post<Pack>('/packs/pixiv-import', input);
export const fetchPixivMetadata = (url: string) => post<PixivMetadata>('/packs/pixiv-metadata', { url });
export const fetchPixivSettings = (reveal = false) => get<PixivSettings>(`/settings/pixiv${reveal ? '?reveal=1' : ''}`);
export const updatePixivSettings = (refreshToken: string) => put<PixivSettings>('/settings/pixiv', { refreshToken });
