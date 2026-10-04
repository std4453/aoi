import { TaskError } from '../../../shared/task-errors.js';
import { fetch, Headers, Response, type Dispatcher } from 'undici';
import { validateFanboxSession } from './fanbox-auth.js';

const maxResponseBytes = 16 * 1024 * 1024;
const failed = () => new TaskError('CHALLENGE_FAILED', 'FlareSolverr 未能通过 FANBOX 验证，请稍后重试');

/** Chromium renders JSON inside a pre element. Decode text only; never execute returned HTML. */
function jsonText(value: string): string {
  if (value.trimStart().startsWith('{')) return value;
  const match = /<pre\b[^>]*>([\s\S]*?)<\/pre>/i.exec(value);
  if (!match || /<[^>]*>/.test(match[1])) throw failed();
  return match[1].replace(/&(quot|amp|lt|gt|apos|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
    const named: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
    if (!name.startsWith('#')) return named[name.toLowerCase()] ?? entity;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

export interface FanboxChallengeResolver {
  resolve(url: string, sessionId: string, signal?: AbortSignal): Promise<Response>;
}

/** Opt-in trusted service. No persistent solver sessions, clearance cache or automatic retries. */
export class FanboxChallengeClient implements FanboxChallengeResolver {
  private busy = false;

  constructor(private origin: string, private proxyUrl?: string, private dispatcher?: Dispatcher) {}

  async resolve(url: string, sessionId: string, signal?: AbortSignal): Promise<Response> {
    if (!/^https:\/\/api\.fanbox\.cc\/post\.info\?postId=[1-9]\d{0,19}$/.test(url)) throw failed();
    validateFanboxSession(sessionId);
    signal?.throwIfAborted();
    if (this.busy) throw new TaskError('CHALLENGE_FAILED', 'FANBOX 验证正在进行，请稍后重试');
    this.busy = true;
    let response: Response | undefined;
    // Keep the slot until the service's maximum solve time, even if the caller cancels.
    // FlareSolverr cannot cancel an in-flight request; its temporary browser expires there.
    const deadline = Date.now() + 65_000;
    let completed = false;
    try {
      response = await fetch(new URL('/v1', this.origin), {
        method: 'POST', redirect: 'manual', dispatcher: this.dispatcher,
        signal: AbortSignal.any([AbortSignal.timeout(65_000), ...(signal ? [signal] : [])]),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60_000,
          disableMedia: true, returnScreenshot: false,
          cookies: sessionId ? [{ name: 'FANBOXSESSID', value: sessionId, domain: '.fanbox.cc', path: '/', secure: true, httpOnly: true }] : [],
          // Chromium's --proxy-server does not accept URL's normalized trailing slash.
          ...(this.proxyUrl ? { proxy: { url: this.proxyUrl.replace(/\/$/, '') } } : {}),
        }),
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw failed();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body!) {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) throw failed();
        chunks.push(chunk);
      }
      completed = true;
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const solution = result?.solution;
      // Upstream may report status 200 even for a blocked page. Require the actual JSON envelope.
      if (result?.status !== 'ok' || solution?.url !== url || typeof solution.response !== 'string') throw failed();
      const text = jsonText(solution.response);
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw failed();
      const envelope = JSON.parse(text);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          (!('body' in envelope) && !('error' in envelope))) throw failed();
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (!envelope.error && envelope.body && Array.isArray(solution.cookies)) {
        for (const cookie of solution.cookies.slice(0, 100)) {
          if (cookie?.name !== 'FANBOXSESSID' || cookie.path !== '/' ||
              !['.fanbox.cc', 'fanbox.cc', 'api.fanbox.cc', '.api.fanbox.cc'].includes(cookie.domain) ||
              (cookie.expiry !== undefined && (!Number.isFinite(cookie.expiry) || cookie.expiry * 1000 <= Date.now()))) continue;
          try {
            const next = validateFanboxSession(cookie.value);
            if (next) headers.append('Set-Cookie', `FANBOXSESSID=${next}; Domain=${cookie.domain}; Path=/; Secure`);
          } catch { /* Ignore invalid cookies without exposing their values. */ }
        }
      }
      return new Response(text, { headers });
    } catch {
      signal?.throwIfAborted();
      // Never surface upstream messages: they can contain URLs, proxy details or credentials.
      throw failed();
    } finally {
      if (response && !response.bodyUsed) await response.body?.cancel().catch(() => {});
      if (completed || Date.now() >= deadline) this.busy = false;
      else setTimeout(() => { this.busy = false; }, deadline - Date.now()).unref();
    }
  }
}
