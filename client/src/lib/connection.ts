import { isPwa } from './pwa';
import { getLastHomeSearch } from './homeStore';
import type { LoginResponse, RuntimeConfig, ServerConnection, ServerHealth } from '../../../shared/types';

const STORAGE_KEY = 'aoi.servers.v1';
export const CONNECTION_EVENT = 'aoi:connection';
export let runtime: RuntimeConfig = { serverSelectionEnabled: false };
export let activeServer: ServerConnection | null = null;
let token = '';
export let connectionState: 'online' | 'offline' | 'recovered' = 'online';

export function savedServers(): ServerConnection[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((s): s is ServerConnection =>
      s && typeof s.id === 'string' && typeof s.alias === 'string' && typeof s.address === 'string' && typeof s.key === 'string') : [];
  } catch { return []; }
}
export function saveServer(server: ServerConnection): void {
  const records = savedServers().filter(item => item.id !== server.id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...records, server]));
}
export async function clearServerCache(id: string): Promise<void> {
  const worker = navigator.serviceWorker?.controller;
  if (worker) {
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('缓存清理超时，请重试')); }, 10000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        channel.port1.close();
        if (event.data?.ok) resolve();
        else reject(new Error('缓存清理失败，请重试'));
      };
      worker.postMessage({ type: 'clear-cache', record: id }, [channel.port2]);
    });
  } else if ('caches' in window) await caches.delete(`aoi-data-${id}`);
}
export async function deleteServer(id: string): Promise<void> {
  await clearServerCache(id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedServers().filter(item => item.id !== id)));
  if (localStorage.getItem('aoi.activeServer') === id) localStorage.removeItem('aoi.activeServer');
}
export function normalizeAddress(value: string): string {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('请输入 http(s)://主机:端口，不支持路径、查询参数或账号');
  }
  return url.origin;
}
export async function loadRuntime(): Promise<void> {
  const res = await fetch(isPwa() ? '/runtime-config.json?__aoi_pwa=1' : '/runtime-config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('无法读取部署配置，请重试');
  runtime = await res.json();
}
export class LoginError extends Error {}
export async function inspectServer(address: string): Promise<ServerHealth> {
  const res = await fetch(`${address}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`服务器响应 HTTP ${res.status}`);
  const health = await res.json() as ServerHealth;
  if (health.service !== 'aoi' || health.status !== 'ok') throw new Error('该地址不是可连接的 AoI 后端');
  return health;
}
export async function login(server: ServerConnection): Promise<void> {
  const res = await fetch(`${server.address}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: server.key }), cache: 'no-store', signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) throw new LoginError('Key 不正确，请修改后重试');
  if (!res.ok) throw new Error(`登录失败：HTTP ${res.status}`);
  const result: LoginResponse = await res.json();
  token = result.token;
  activeServer = { ...server, verified: true };
  saveServer(activeServer);
  localStorage.setItem('aoi.activeServer', server.id);
  setConnectionState('online');
}
export function enterOffline(server: ServerConnection): void {
  activeServer = server;
  token = '';
  localStorage.setItem('aoi.activeServer', server.id);
  setConnectionState('offline');
}
export function setConnectionState(state: typeof connectionState): void {
  connectionState = state;
  window.dispatchEvent(new Event(CONNECTION_EVENT));
}
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export function apiUrl(path: string, resource = false): string {
  const url = new URL(path, activeServer?.address || location.origin);
  if (activeServer) url.searchParams.set('__aoi_record', activeServer.id);
  if (isPwa()) url.searchParams.set('__aoi_pwa', '1');
  if (connectionState !== 'online') url.searchParams.set('__aoi_offline', '1');
  if (resource && token) url.searchParams.set('access_token', token);
  return url.href;
}
export const resourceUrl = (path: string): string => apiUrl(path, true);
export function returnToServers(): void {
  sessionStorage.setItem('aoi.chooseServer', '1');
  // Reload also disposes uploads, streams, image pools and in-memory page caches.
  location.assign('/servers');
}
export function handleUnauthorized(): void {
  window.dispatchEvent(new Event('aoi:unauthorized'));
}
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (connectionState !== 'online' && init.method && init.method !== 'GET') throw new Error('当前为离线浏览，请恢复连接并刷新后操作');
  try {
    const response = await fetch(apiUrl(path), { ...init, headers: { ...authHeaders(), ...init.headers }, cache: 'no-store' });
    if (response.status === 401) handleUnauthorized();
    if (response.headers.get('X-AoI-Cache') === 'offline' && connectionState === 'online') setConnectionState('offline');
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    setConnectionState('offline');
    throw error;
  }
}

// A full navigation renews credentials as well as data after offline browsing.
export function refreshRecoveredHome(): boolean {
  if (connectionState !== 'recovered') return false;
  const search = location.pathname === '/' ? location.search : getLastHomeSearch();
  location.assign(`/${search}`);
  return true;
}
