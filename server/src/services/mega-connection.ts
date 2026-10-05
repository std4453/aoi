import { API } from '@std4453/megajs';
import { config } from '~/config';
import { TaskError } from '~/task-errors';
import { createOutboundFetch } from './outbound-fetch';

class MegaApi extends API {
  constructor(options: ConstructorParameters<typeof API>[1], private readonly controller: AbortController) {
    super(false, options);
  }

  override request(...[json, callback, retry]: Parameters<API['request']>): ReturnType<API['request']> {
    // MEGAJS discards the promise returned by its callback dispatch. A metadata
    // parser throw would otherwise escape loadAttributes() and terminate AoI.
    return super.request(json, callback && ((error, response) => {
      try {
        callback(error, response);
      } catch {
        this.controller.abort(new TaskError('SOURCE_UNAVAILABLE', 'MEGA 返回的文件信息无效，请稍后重试'));
      }
    }), retry);
  }
}

/** Shared by account authentication, metadata and file transfers. */
export function createMegaConnection(signal?: AbortSignal) {
  const controller = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const outbound = createOutboundFetch(config.outboundProxyUrl);
  const api = new MegaApi({ fetch: async (input, init) => {
    const endpoint = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port ||
      !['mega.nz', 'mega.co.nz'].some(domain => endpoint.hostname === domain || endpoint.hostname.endsWith(`.${domain}`))) {
      throw new TaskError('SOURCE_UNAVAILABLE', 'MEGA 返回了不受信任的下载地址');
    }
    const signals = [AbortSignal.timeout(60_000), operationSignal, init?.signal].filter((value): value is AbortSignal => !!value);
    const response = await outbound.fetch(endpoint, { ...init, signal: AbortSignal.any(signals), redirect: 'error' });
    const range = /\/(\d+)-(\d+)$/.exec(endpoint.pathname);
    const maxBytes = range ? Number(range[2]) - Number(range[1]) + 1
      : Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, config.maxArchiveEntries * 2_048));
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new TaskError('RESOURCE_LIMIT', 'MEGA 响应超过资源限制');
    }
    if (!response.body) return response;
    let received = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, sink) {
        received += chunk.byteLength;
        if (received > maxBytes) throw new TaskError('RESOURCE_LIMIT', 'MEGA 响应超过资源限制');
        sink.enqueue(chunk);
      },
    }));
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
  } }, controller);
  return {
    api, signal: operationSignal,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      operationSignal.throwIfAborted();
      let abort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(operationSignal.reason);
        operationSignal.addEventListener('abort', abort, { once: true });
      });
      try { return await Promise.race([operation(), aborted]); }
      catch (error) {
        if (controller.signal.reason instanceof TaskError) throw controller.signal.reason;
        throw error;
      } finally { if (abort) operationSignal.removeEventListener('abort', abort); }
    },
    async close() {
      // Abort active fetches. Closing SDK API itself can make scheduled retries
      // throw outside its promises. Keepalive is disabled for every operation.
      controller.abort();
      await outbound.close();
    },
  };
}
