import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../config.js';
import type { BlobInfo } from './protocol.js';

export interface JsonObject { value: unknown; etag: string }
export interface ObjectStore {
  json(key: string): Promise<JsonObject | undefined>;
  putJson(key: string, value: unknown, previous?: string): Promise<void>;
  upload(key: string, filename: string, info: BlobInfo): Promise<boolean>;
  download(key: string, filename: string, size: number): Promise<void>;
  close(): void;
}
function missing(error: unknown): boolean {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}
export class S3Store implements ObjectStore {
  private readonly client = new S3Client({
    endpoint: config.s3Endpoint, region: config.s3Region, forcePathStyle: true,
    credentials: { accessKeyId: config.s3AccessKey!, secretAccessKey: config.s3SecretKey! },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    retryMode: 'standard', maxAttempts: 3,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
  });
  private input(key: string) { return { Bucket: config.s3Bucket!, Key: `${config.s3Prefix.replace(/\/$/, '')}/${key}` }; }
  async json(key: string): Promise<JsonObject | undefined> {
    try {
      const result = await this.client.send(new GetObjectCommand(this.input(key)));
      if (!result.Body || !result.ETag) throw new Error('Incomplete S3 response');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of result.Body as Readable) {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) {
          (result.Body as Readable).destroy();
          throw new Error('Replication metadata exceeds 128 MiB');
        }
        chunks.push(Buffer.from(chunk));
      }
      return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: result.ETag };
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async putJson(key: string, value: unknown, previous?: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      ...this.input(key), Body: JSON.stringify(value), ContentType: 'application/json',
      ...(previous ? { IfMatch: previous } : { IfNoneMatch: '*' }),
    }));
  }
  async upload(key: string, filename: string, info: BlobInfo): Promise<boolean> {
    try {
      const existing = await this.client.send(new HeadObjectCommand(this.input(key)));
      if (existing.ContentLength !== info.size || existing.Metadata?.sha256 !== info.hash) {
        throw new Error('Existing S3 object does not match its content address');
      }
      return false;
    } catch (error) { if (!missing(error)) throw error; }
    await new Upload({
      client: this.client,
      params: { ...this.input(key), Body: fs.createReadStream(filename), ContentLength: info.size, Metadata: { sha256: info.hash } },
      queueSize: 2, partSize: 16 * 1024 * 1024, leavePartsOnError: false,
    }).done();
    return true;
  }
  async download(key: string, filename: string, size: number): Promise<void> {
    const result = await this.client.send(new GetObjectCommand(this.input(key)));
    if (!result.Body) throw new Error('Missing S3 body');
    const body = result.Body as Readable;
    if (result.ContentLength !== size) {
      body.destroy();
      throw new Error('S3 content length mismatch');
    }
    let received = 0;
    try {
      await pipeline(body, new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(received > size ? new Error('S3 object exceeds declared size') : null, chunk);
        },
      }), fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
      if (received !== size) throw new Error('Truncated S3 object');
    } catch (error) {
      await fs.promises.rm(filename, { force: true });
      throw error;
    }
  }
  close(): void { this.client.destroy(); }
}
