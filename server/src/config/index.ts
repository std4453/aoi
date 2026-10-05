import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseProxyUrl } from '~/services/outbound-fetch';
import { readExternalConfig } from './external-sources';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = __dirname.includes(`${path.sep}dist${path.sep}server${path.sep}`)
  ? path.resolve(__dirname, '../../../../..')
  : path.resolve(__dirname, '../../..');
const defaultDataDir = path.join(projectRoot, 'data');

const flag = z.enum(['true', 'false', '1', '0']).default('false').transform(value => value === 'true' || value === '1');

const configSchema = z.object({
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

if (Boolean(parsed.tlsCertFile) !== Boolean(parsed.tlsKeyFile)) {
  throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be configured together');
}

export const config = {
  ...parsed,
  ...readExternalConfig(process.env, parsed.outboundProxyUrl),
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
