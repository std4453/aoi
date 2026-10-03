import { post } from './client';
import type { MegaMetadata } from '../../../shared/types';

export const fetchMegaMetadata = (url: string, sharePassword?: string) =>
  post<MegaMetadata>('/packs/mega-metadata', { url, sharePassword });
