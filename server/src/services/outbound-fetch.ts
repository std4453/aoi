import { ProxyAgent } from 'undici';

export function parseProxyUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname ||
      !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error();
    return url.href;
  } catch {
    // Never echo an invalid URL: it may contain proxy credentials.
    throw new Error('AOI_PROXY_URL must be an HTTP, HTTPS or SOCKS5 proxy URL without a path, query or fragment');
  }
}

/** Isolated per import; never changes the dispatcher used by local APIs or replication. */
export function createOutboundFetch(proxyUrl?: string) {
  const uri = parseProxyUrl(proxyUrl);
  const dispatcher = uri ? new ProxyAgent({ uri, proxyTunnel: true }) : undefined;
  return {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const options: RequestInit & { dispatcher?: ProxyAgent } = { ...init, ...(dispatcher ? { dispatcher } : {}) };
      return globalThis.fetch(input, options);
    },
    async close(): Promise<void> {
      // destroy also releases stalled CONNECT requests after the import is cancelled.
      await dispatcher?.destroy();
    },
  };
}
