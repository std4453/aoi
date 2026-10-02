import { get, post } from './client';
import type { Pack, PixivImportRequest, PixivImportStatus } from '../../../shared/types';

export const startPixivImport = (input: PixivImportRequest) => post<Pack>('/packs/pixiv-import', input);
export const fetchPixivImport = (id: string) => get<PixivImportStatus>(`/packs/${id}/pixiv-import`);
export const retryPixivImport = (id: string) => post(`/packs/${id}/pixiv-retry`);
