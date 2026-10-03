import type { LoginResponse, RuntimeConfig, ServerConnection, ServerHealth } from '../../../shared/types';

const STORAGE_KEY = 'aoi.servers.v1';
export let runtime: RuntimeConfig = { serverSelectionEnabled: false };
export let activeServer: ServerConnection | null = null;
let token = '';
export let serverWritable = true;
export let serverCanDownloadArchive = true;
function setServerCapabilities(health: Pick<ServerHealth, 'writable' | 'capabilities'>): void {
  serverWritable = health.writable !== false;
  serverCanDownloadArchive = health.capabilities?.generatedArchiveDownload ?? serverWritable;
}

type ConnectionStatus = 'connected' | 'connecting' | 'failed';
let snapshot = { status: 'connected' as ConnectionStatus, serverWritable, serverCanDownloadArchive };
const listeners = new Set<() => void>();
export const getConnectionState = () => snapshot;
export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function setConnectionStatus(status: ConnectionStatus): void {
  snapshot = { status, serverWritable, serverCanDownloadArchive };
  for (const listener of listeners) listener();
}
let cachedStartup = false;
let attempt: { controller: AbortController; promise: Promise<void> } | null = null;

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
export async function deleteServer(id: string): Promise<void> {
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
export async function loadRuntime(signal?: AbortSignal): Promise<void> {
  const res = await fetch('/runtime-config.json', { cache: 'no-store', signal });
  if (!res.ok) throw new Error('无法读取部署配置，请重试');
  runtime = await res.json();
}
export class LoginError extends Error {}
function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(8000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export async function inspectServer(address: string, signal?: AbortSignal): Promise<ServerHealth> {
  const res = await fetch(`${address}/api/health`, { cache: 'no-store', signal: requestSignal(signal) });
  if (!res.ok) throw new Error(`服务器响应 HTTP ${res.status}`);
  const health = await res.json() as ServerHealth;
  signal?.throwIfAborted();
  if (health.service !== 'aoi' || health.status !== 'ok') throw new Error('该地址不是可连接的 AoI 后端');
  return health;
}
async function login(server: ServerConnection, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${server.address}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: server.key }), cache: 'no-store', signal: requestSignal(signal),
  });
  if (res.status === 401) throw new LoginError('Key 不正确，请修改后重试');
  if (!res.ok) throw new Error(`登录失败：HTTP ${res.status}`);
  const result: LoginResponse = await res.json();
  signal.throwIfAborted();
  if (typeof result.token !== 'string') throw new Error('服务器返回了无效的登录信息');
  token = result.token;
  activeServer = { ...server, token };
  setServerCapabilities(activeServer);
  saveServer(activeServer);
  localStorage.setItem('aoi.activeServer', server.id);
}
export function restoreCachedConnection(server: ServerConnection): boolean {
  if (!runtime.serverSelectionEnabled || typeof server.token !== 'string') return false;
  activeServer = { ...server };
  token = server.token;
  cachedStartup = true;
  setServerCapabilities(server);
  setConnectionStatus('connecting');
  return true;
}
export function cancelConnection(): void {
  attempt?.controller.abort();
  attempt = null;
}
export function connectServer(server: ServerConnection): Promise<void> {
  cancelConnection();
  const controller = new AbortController();
  const { signal } = controller;
  setConnectionStatus('connecting');
  const promise = (async () => {
    try {
      const health = await inspectServer(server.address, signal);
      await login({
        ...server,
        key: health.authRequired ? server.key : '',
        writable: health.writable !== false,
        role: health.role,
        capabilities: health.capabilities,
      }, signal);
      setConnectionStatus('connected');
    } catch (error) {
      if (!signal.aborted) setConnectionStatus('failed');
      throw error;
    } finally {
      if (attempt?.controller === controller) attempt = null;
    }
  })();
  attempt = { controller, promise };
  return promise;
}
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export function apiUrl(path: string, resource = false): string {
  const url = new URL(path, activeServer?.address || location.origin);
  if (resource && token) url.searchParams.set('access_token', token);
  return url.href;
}
export const resourceUrl = (path: string): string => apiUrl(path, true);
export function returnToServers(): void {
  cancelConnection();
  sessionStorage.setItem('aoi.chooseServer', '1');
  // Reload also disposes uploads, streams, image pools and in-memory page caches.
  location.assign('/servers');
}
export function handleUnauthorized(): void {
  if (cachedStartup) {
    if (activeServer) {
      const { token: _expired, ...server } = activeServer;
      activeServer = server;
      saveServer(server);
    }
    setConnectionStatus('failed');
    return;
  }
  sessionStorage.setItem('aoi.loginError', '登录已失效，请重新连接服务器');
  returnToServers();
}
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!serverWritable && !['GET', 'HEAD', 'OPTIONS'].includes((init.method || 'GET').toUpperCase())) {
    throw new Error('当前连接的是只读备服务器');
  }
  const requestedToken = token;
  const requestedServer = activeServer;
  const request = () => fetch(apiUrl(path), { ...init, headers: { ...authHeaders(), ...init.headers }, cache: 'no-store' });
  let responseToken = requestedToken;
  let response = await request();
  if (response.status === 401 && cachedStartup) {
    // A server restart rotates its token. Let the background login finish, then
    // retry reads once with the new token without remounting the current page.
    await attempt?.promise.catch(() => {});
    init.signal?.throwIfAborted();
    if (activeServer?.id === requestedServer?.id && activeServer?.address === requestedServer?.address &&
        token !== requestedToken && ['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase())) {
      await response.body?.cancel();
      responseToken = token;
      response = await request();
    }
  }
  if (response.status === 401 && token === responseToken) handleUnauthorized();
  return response;
}
