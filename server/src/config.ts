import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  dataDir: z.string().default(path.join(__dirname, '../../data')),
  maxUploadSize: z.coerce.number().default(5 * 1024 * 1024 * 1024), // 5GB
  uploadChunkSize: z.coerce.number().default(5 * 1024 * 1024), // 5MB
});

const parsed = configSchema.parse({
  port: process.env.PORT,
  host: process.env.HOST,
  dataDir: process.env.DATA_DIR,
  maxUploadSize: process.env.MAX_UPLOAD_SIZE,
  uploadChunkSize: process.env.UPLOAD_CHUNK_SIZE,
});

export const config = {
  ...parsed,
  dirs: {
    uploads: path.join(parsed.dataDir, 'uploads'),
    archives: path.join(parsed.dataDir, 'archives'),
    extracted: path.join(parsed.dataDir, 'extracted'),
    generated: path.join(parsed.dataDir, 'generated'),
    thumbnails: path.join(parsed.dataDir, 'thumbnails'),
    db: path.join(parsed.dataDir, 'db'),
  },
};
