import { apiFetch } from '../lib/connection';
import type { BrowserLoginProvider, BrowserLoginSession } from '../../../shared/types';

async function request<T>(provider: BrowserLoginProvider, path: string, method: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/settings/${provider}/browser-login${path}`, {
    method, headers: { 'X-AoI-Browser-Login': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '浏览器登录失败');
  return value;
}
export const getBrowserLogin = (provider: BrowserLoginProvider) => request<{ session: BrowserLoginSession | null; error?: string }>(provider, '', 'GET');
export const startBrowserLogin = (provider: BrowserLoginProvider, mobile: boolean) => request<BrowserLoginSession>(provider, '', 'POST', { mobile });
export const completeBrowserLogin = (provider: BrowserLoginProvider, id: string) => request(provider, `/${id}/complete`, 'POST');
export const cancelBrowserLogin = (provider: BrowserLoginProvider, id: string) => request(provider, `/${id}`, 'DELETE');
