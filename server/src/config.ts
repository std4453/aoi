import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = __dirname.includes(`${path.sep}dist${path.sep}server${path.sep}`)
  ? path.resolve(__dirname, '../../../..')
  : path.resolve(__dirname, '../..');
const defaultDataDir = path.join(projectRoot, 'data');

const flag = z.enum(['true', 'false', '1', '0']).default('false').transform(value => value === 'true' || value === '1');

const configSchema = z.object({
  frontendOnly: flag,
  replicationRole: z.enum(['off', 'primary', 'replica']).default('off'),
  replicationInterval: z.coerce.number().int().min(5).default(300),
  s3Endpoint: z.string().url().optional(),
  s3Region: z.string().default('us-east-1'),
  s3Bucket: z.string().optional(),
  s3Prefix: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/).default('aoi'),
  s3AccessKey: z.string().optional(),
  s3SecretKey: z.string().optional(),
  serverSelectionEnabled: flag,
  authKey: z.string().max(4096).default(''),
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
  replicationRole: process.env.AOI_REPLICATION_ROLE,
  replicationInterval: process.env.AOI_REPLICATION_INTERVAL,
  s3Endpoint: process.env.AOI_S3_ENDPOINT,
  s3Region: process.env.AOI_S3_REGION,
  s3Bucket: process.env.AOI_S3_BUCKET,
  s3Prefix: process.env.AOI_S3_PREFIX,
  s3AccessKey: process.env.AOI_S3_ACCESS_KEY,
  s3SecretKey: process.env.AOI_S3_SECRET_KEY,
  serverSelectionEnabled: process.env.SERVER_SELECTION_ENABLED,
  authKey: process.env.AUTH_KEY,
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

if (!parsed.frontendOnly && parsed.replicationRole !== 'off' &&
    (!parsed.s3Bucket || !parsed.s3AccessKey || !parsed.s3SecretKey)) {
  throw new Error('Replication requires AOI_S3_BUCKET, AOI_S3_ACCESS_KEY and AOI_S3_SECRET_KEY');
}

export const config = {
  ...parsed,
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
