import { post, get, del } from './client';
import type { MegaMetadata, MegaSettings, MegaLoginInput } from '../../../shared/types';

export const fetchMegaMetadata = (url: string, sharePassword?: string) =>
  post<MegaMetadata>('/packs/mega-metadata', { url, sharePassword });

export const fetchMegaSettings = () => get<MegaSettings>('/settings/mega');
export const loginMega = (input: MegaLoginInput) => post<MegaSettings>('/settings/mega/login', input);
export const logoutMega = () => del<MegaSettings>('/settings/mega');
