import { apiFetch } from '../lib/connection';

async function request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await apiFetch(`/api${path}`, {
    method, signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const result = await res.json().catch(() => ({}));
    throw new Error(result.error || `HTTP ${res.status}`);
  }
  return res.json();
}
export const get = <T>(path: string, signal?: AbortSignal): Promise<T> => request(path, 'GET', undefined, signal);
export const post = <T>(path: string, body?: unknown): Promise<T> => request(path, 'POST', body);
export const put = <T>(path: string, body?: unknown): Promise<T> => request(path, 'PUT', body);
export const patch = <T>(path: string, body?: unknown): Promise<T> => request(path, 'PATCH', body);
export const del = <T>(path: string): Promise<T> => request(path, 'DELETE');
