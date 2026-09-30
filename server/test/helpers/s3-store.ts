import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

// Minimal S3 wire fixture exercises the actual SDK (including conditional PUT)
// without a network service dependency in the regression suite.
export async function startObjectStore() {
  const objects = new Map<string, { data: Buffer; etag: string; metadata: string }>();
  let unavailable = false;
  const server = createServer(async (request, response) => {
    if (unavailable) { response.writeHead(503); response.end(); return; }
    const key = new URL(request.url!, 'http://localhost').pathname;
    const existing = objects.get(key);
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if ((request.headers['if-none-match'] === '*' && existing) ||
          (request.headers['if-match'] && request.headers['if-match'] !== existing?.etag)) {
        response.writeHead(412); response.end(); return;
      }
      const data = Buffer.concat(chunks);
      const etag = `"${createHash('md5').update(data).digest('hex')}"`;
      objects.set(key, { data, etag, metadata: String(request.headers['x-amz-meta-sha256'] || '') });
      response.writeHead(200, { ETag: etag }); response.end(); return;
    }
    if (!existing) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { ETag: existing.etag, 'Content-Length': existing.data.length, 'x-amz-meta-sha256': existing.metadata });
    response.end(request.method === 'HEAD' ? undefined : existing.data);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${address.port}`, objects,
    offline(value: boolean) { unavailable = value; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
