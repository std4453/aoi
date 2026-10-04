import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseProxyUrl } from './services/outbound-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = __dirname.includes(`${path.sep}dist${path.sep}server${path.sep}`)
  ? path.resolve(__dirname, '../../../..')
  : path.resolve(__dirname, '../..');
const defaultDataDir = path.join(projectRoot, 'data');

const flag = z.enum(['true', 'false', '1', '0']).default('false').transform(value => value === 'true' || value === '1');

const configSchema = z.object({
  flaresolverrUrl: z.string().url().optional(),
  flaresolverrProxyUrl: z.string().optional().transform(parseProxyUrl),
  browserLoginUrl: z.string().url().optional(),
  browserLoginPublicUrl: z.string().url().optional(),
  browserLoginKeyFile: z.string().optional(),
  browserLoginTrustedHttp: flag,
  fanboxSessionId: z.string().default(''),
  fanboxCookiesFile: z.string().optional(),
  pixivProxyUrl: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)).optional(),
  pixivCookie: z.string().max(8192).refine(value => !/[\r\n]/.test(value)).default(''),
  pixivRefreshToken: z.string().max(8192).regex(/^[^\s]*$/).default(''),
  frontendOnly: flag,
  snapshotEnabled: z.enum(['true', 'false', '1', '0']).default('true').transform(value => value === 'true' || value === '1'),
  replicaSourceUrl: z.string().url().optional().transform(value => {
    if (!value) return undefined;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('AOI_REPLICA_SOURCE_URL must be an http(s) origin');
    }
    return url.origin;
  }),
  replicaSourceKey: z.string().max(4096).default(''),
  replicationInterval: z.coerce.number().int().min(5).default(300),
  serverSelectionEnabled: flag,
  authKey: z.string().max(4096).default(''),
  outboundProxyUrl: z.string().optional().transform(parseProxyUrl),
  tlsCertFile: z.string().optional(),
  tlsKeyFile: z.string().optional(),
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  dataDir: z.string().min(1).default(defaultDataDir).transform(value => path.resolve(value)),
  maxUploadSize: z.coerce.number().int().positive().default(5 * 1024 * 1024 * 1024),
  maxApiBodySize: z.coerce.number().int().positive().max(64 * 1024 * 1024).default(16 * 1024 * 1024),
  maxExtractedSize: z.coerce.number().int().positive().default(20 * 1024 * 1024 * 1024),
  maxArchiveEntries: z.coerce.number().int().positive().default(100_000),
  maxCompressionRatio: z.coerce.number().positive().default(1_000),
  maxImagePixels: z.coerce.number().int().positive().default(100_000_000),
  archiveCommandTimeout: z.coerce.number().int().positive().default(30 * 60 * 1_000),
  databaseBusyTimeout: z.coerce.number().int().positive().default(5_000),
  instanceLockTimeout: z.coerce.number().int().positive().default(1_000),
  backupRetention: z.coerce.number().int().min(1).max(100).default(5),
  shutdownTimeout: z.coerce.number().int().positive().default(25_000),
});

const parsed = configSchema.parse({
  flaresolverrUrl: process.env.AOI_FLARESOLVERR_URL || undefined,
  flaresolverrProxyUrl: process.env.AOI_FLARESOLVERR_PROXY_URL || undefined,
  browserLoginUrl: process.env.AOI_BROWSER_LOGIN_URL || undefined,
  browserLoginPublicUrl: process.env.AOI_BROWSER_LOGIN_PUBLIC_URL || undefined,
  browserLoginKeyFile: process.env.AOI_BROWSER_LOGIN_KEY_FILE || undefined,
  browserLoginTrustedHttp: process.env.AOI_BROWSER_LOGIN_TRUSTED_HTTP,
  fanboxSessionId: process.env.FANBOX_SESSION_ID,
  fanboxCookiesFile: process.env.FANBOX_COOKIES_FILE || undefined,
  pixivProxyUrl: process.env.PIXIV_PROXY_URL || undefined,
  pixivCookie: process.env.PIXIV_COOKIE,
  pixivRefreshToken: process.env.PIXIV_REFRESH_TOKEN,
  frontendOnly: process.env.FRONTEND_ONLY,
  snapshotEnabled: process.env.AOI_SNAPSHOT_ENABLED,
  replicaSourceUrl: process.env.AOI_REPLICA_SOURCE_URL,
  replicaSourceKey: process.env.AOI_REPLICA_SOURCE_KEY,
  replicationInterval: process.env.AOI_REPLICATION_INTERVAL,
  serverSelectionEnabled: process.env.SERVER_SELECTION_ENABLED,
  authKey: process.env.AUTH_KEY,
  outboundProxyUrl: process.env.AOI_PROXY_URL,
  tlsCertFile: process.env.TLS_CERT_FILE,
  tlsKeyFile: process.env.TLS_KEY_FILE,
  port: process.env.PORT,
  host: process.env.HOST,
  dataDir: process.env.DATA_DIR,
  maxUploadSize: process.env.MAX_UPLOAD_SIZE,
  maxApiBodySize: process.env.MAX_API_BODY_SIZE,
  maxExtractedSize: process.env.MAX_EXTRACTED_SIZE,
  maxArchiveEntries: process.env.MAX_ARCHIVE_ENTRIES,
  maxCompressionRatio: process.env.MAX_COMPRESSION_RATIO,
  maxImagePixels: process.env.MAX_IMAGE_PIXELS,
  archiveCommandTimeout: process.env.ARCHIVE_COMMAND_TIMEOUT,
  databaseBusyTimeout: process.env.DATABASE_BUSY_TIMEOUT,
  instanceLockTimeout: process.env.INSTANCE_LOCK_TIMEOUT,
  backupRetention: process.env.BACKUP_RETENTION,
  shutdownTimeout: process.env.SHUTDOWN_TIMEOUT,
});

if (parsed.flaresolverrUrl) {
  const url = new URL(parsed.flaresolverrUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('AOI_FLARESOLVERR_URL must be a trusted http(s) origin');
  }
  const proxy = parsed.flaresolverrProxyUrl ?? parsed.outboundProxyUrl;
  if (proxy && (new URL(proxy).username || new URL(proxy).password)) {
    throw new Error('FlareSolverr temporary requests require a proxy without URL credentials');
  }
} else if (parsed.flaresolverrProxyUrl) {
  throw new Error('AOI_FLARESOLVERR_PROXY_URL requires AOI_FLARESOLVERR_URL');
}

for (const [value, internal] of [[parsed.browserLoginUrl, true], [parsed.browserLoginPublicUrl, false]] as const) {
  if (!value) continue;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || internal && parsed.browserLoginTrustedHttp)))) {
    throw new Error('Browser login URLs require HTTPS or loopback HTTP; private control HTTP requires AOI_BROWSER_LOGIN_TRUSTED_HTTP');
  }
}
if ([parsed.browserLoginUrl, parsed.browserLoginPublicUrl, parsed.browserLoginKeyFile].filter(Boolean).length % 3 !== 0) {
  throw new Error('Configure all three AOI_BROWSER_LOGIN_URL, AOI_BROWSER_LOGIN_PUBLIC_URL and AOI_BROWSER_LOGIN_KEY_FILE');
}

if (Boolean(parsed.tlsCertFile) !== Boolean(parsed.tlsKeyFile)) {
  throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be configured together');
}

export const config = {
  ...parsed,
  isReplica: Boolean(parsed.replicaSourceUrl),
  dirs: {
    uploads: path.join(parsed.dataDir, 'uploads'),
    archives: path.join(parsed.dataDir, 'archives'),
    extracted: path.join(parsed.dataDir, 'extracted'),
    generated: path.join(parsed.dataDir, 'generated'),
    thumbnails: path.join(parsed.dataDir, 'thumbnails'),
    db: path.join(parsed.dataDir, 'db'),
    backups: path.join(parsed.dataDir, 'backups'),
  },
};
