import { z } from 'zod';
import { parseProxyUrl } from '~/services/outbound-fetch';

const flag = z.enum(['true', 'false', '1', '0']).default('false').transform(value => value === 'true' || value === '1');
const schema = z.object({
  pixiv: z.object({
    proxyUrl: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)).optional(),
    cookie: z.string().max(8192).refine(value => !/[\r\n]/.test(value)).default(''),
    refreshToken: z.string().max(8192).regex(/^[^\s]*$/).default(''),
  }),
  fanbox: z.object({ sessionId: z.string().default(''), cookiesFile: z.string().optional() }),
  browserLogin: z.object({
    url: z.string().url().optional(), publicUrl: z.string().url().optional(),
    keyFile: z.string().optional(), trustedHttp: flag,
  }),
  flaresolverr: z.object({
    url: z.string().url().optional(), proxyUrl: z.string().optional().transform(parseProxyUrl),
  }),
});

/** Deployment environment names remain stable; consumers use service-specific groups. */
export function readExternalConfig(env: NodeJS.ProcessEnv, outboundProxyUrl?: string) {
  const parsed = schema.parse({
    pixiv: { proxyUrl: env.PIXIV_PROXY_URL || undefined, cookie: env.PIXIV_COOKIE, refreshToken: env.PIXIV_REFRESH_TOKEN },
    fanbox: { sessionId: env.FANBOX_SESSION_ID, cookiesFile: env.FANBOX_COOKIES_FILE || undefined },
    browserLogin: { url: env.AOI_BROWSER_LOGIN_URL || undefined, publicUrl: env.AOI_BROWSER_LOGIN_PUBLIC_URL || undefined,
      keyFile: env.AOI_BROWSER_LOGIN_KEY_FILE || undefined, trustedHttp: env.AOI_BROWSER_LOGIN_TRUSTED_HTTP },
    flaresolverr: { url: env.AOI_FLARESOLVERR_URL || undefined, proxyUrl: env.AOI_FLARESOLVERR_PROXY_URL || undefined },
  });
  if (parsed.flaresolverr.url) {
    const url = new URL(parsed.flaresolverr.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('AOI_FLARESOLVERR_URL must be a trusted http(s) origin');
    }
    const proxy = parsed.flaresolverr.proxyUrl ?? outboundProxyUrl;
    if (proxy && (new URL(proxy).username || new URL(proxy).password)) {
      throw new Error('FlareSolverr temporary requests require a proxy without URL credentials');
    }
  } else if (parsed.flaresolverr.proxyUrl) {
    throw new Error('AOI_FLARESOLVERR_PROXY_URL requires AOI_FLARESOLVERR_URL');
  }

  for (const [value, internal] of [[parsed.browserLogin.url, true], [parsed.browserLogin.publicUrl, false]] as const) {
    if (!value) continue;
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || internal && parsed.browserLogin.trustedHttp)))) {
      throw new Error('Browser login URLs require HTTPS or loopback HTTP; private control HTTP requires AOI_BROWSER_LOGIN_TRUSTED_HTTP');
    }
  }
  if ([parsed.browserLogin.url, parsed.browserLogin.publicUrl, parsed.browserLogin.keyFile].filter(Boolean).length % 3 !== 0) {
    throw new Error('Configure all three AOI_BROWSER_LOGIN_URL, AOI_BROWSER_LOGIN_PUBLIC_URL and AOI_BROWSER_LOGIN_KEY_FILE');
  }
  return parsed;
}
