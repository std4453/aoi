import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { createOutboundFetch, parseProxyUrl } from '../src/services/outbound-fetch.js';

async function serve(server: Server) {
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}

test('proxy configuration accepts supported schemes and redacts invalid URLs', () => {
  assert.equal(parseProxyUrl(undefined), undefined);
  assert.equal(parseProxyUrl('  '), undefined);
  assert.equal(parseProxyUrl(' http://localhost:7890 '), 'http://localhost:7890/');
  assert.equal(parseProxyUrl('https://localhost:7890'), 'https://localhost:7890/');
  assert.equal(parseProxyUrl('socks5://localhost:7890'), 'socks5://localhost:7890');

  for (const value of [
    'ftp://private-user:private-secret@localhost:7890',
    'http://private-user:private-secret@localhost:7890/path',
    'http://private-user:private-secret@localhost:7890/?token=private-secret',
    'http://private-user:private-secret@localhost:7890/#private-secret',
    'private-user:private-secret',
  ]) {
    assert.throws(() => parseProxyUrl(value), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AOI_PROXY_URL/);
      assert.doesNotMatch(error.message, /private-user|private-secret/);
      return true;
    });
  }
});

test('unconfigured outbound fetch connects directly to a local target', { timeout: 5000 }, async t => {
  const target = await serve(createServer((request, response) => {
    assert.equal(request.url, '/direct');
    response.end('direct response');
  }));
  t.after(() => target.close());
  const outbound = createOutboundFetch();
  t.after(() => outbound.close());
  const response = await outbound.fetch(`${target.url}/direct`);
  assert.equal(await response.text(), 'direct response');
});

test('HTTP proxy tunnels requests and keeps proxy credentials out of target headers', { timeout: 5000 }, async t => {
  const requests: Array<{ path?: string; proxyAuth?: string; auth?: string }> = [];
  const target = await serve(createServer((request, response) => {
    requests.push({
      path: request.url,
      proxyAuth: request.headers['proxy-authorization'],
      auth: request.headers.authorization,
    });
    response.end('target response');
  }));
  t.after(() => target.close());
  const tunnels: Array<{ authority?: string; auth?: string }> = [];
  const upstreams = new Set<Socket>();
  const proxyServer = createServer((_request, response) => {
    response.writeHead(400).end('CONNECT required');
  });
  proxyServer.on('connect', (request, downstream, head) => {
    tunnels.push({ authority: request.url, auth: request.headers['proxy-authorization'] });
    const authority = new URL(`http://${request.url}`);
    const upstream = connect(Number(authority.port), authority.hostname);
    upstreams.add(upstream);
    upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.on('close', () => upstream.destroy());
    upstream.on('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
  });
  const proxy = await serve(proxyServer);
  t.after(async () => {
    for (const socket of upstreams) socket.destroy();
    await proxy.close();
  });
  const proxyUrl = new URL(proxy.url);
  proxyUrl.username = 'proxy-user';
  proxyUrl.password = 'private-secret';
  const outbound = createOutboundFetch(proxyUrl.href);
  t.after(() => outbound.close());

  const response = await outbound.fetch(`${target.url}/proxied`, {
    headers: { authorization: 'Bearer target-token' },
  });
  assert.equal(await response.text(), 'target response');
  assert.deepEqual(tunnels, [{
    authority: new URL(target.url).host,
    auth: `Basic ${Buffer.from('proxy-user:private-secret').toString('base64')}`,
  }]);
  assert.deepEqual(requests[0], {
    path: '/proxied', proxyAuth: undefined, auth: 'Bearer target-token',
  });

  // Creating a MEGA transport must not install a global dispatcher for local APIs.
  const directResponse = await fetch(`${target.url}/still-direct`);
  assert.equal(await directResponse.text(), 'target response');
  assert.equal(tunnels.length, 1);
  assert.equal(requests[1].path, '/still-direct');
});

test('proxy rejection never silently falls back to a direct connection', { timeout: 5000 }, async t => {
  let targetRequests = 0;
  const target = await serve(createServer((_request, response) => {
    targetRequests++;
    response.end('must not be reached');
  }));
  t.after(() => target.close());
  let connectRequests = 0;
  const proxyServer = createServer();
  proxyServer.on('connect', (_request, socket) => {
    connectRequests++;
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  const proxy = await serve(proxyServer);
  t.after(() => proxy.close());
  const outbound = createOutboundFetch(proxy.url);
  t.after(() => outbound.close());
  await assert.rejects(outbound.fetch(target.url));
  assert.ok(connectRequests > 0);
  assert.equal(targetRequests, 0);
});

test('cancelling a stalled CONNECT and closing its transport releases the proxy socket', { timeout: 5000 }, async t => {
  const proxyServer = createServer();
  const connected = once(proxyServer, 'connect');
  const proxy = await serve(proxyServer);
  t.after(() => proxy.close());
  const outbound = createOutboundFetch(proxy.url);
  t.after(() => outbound.close());
  const controller = new AbortController();
  const request = outbound.fetch('http://unreachable.invalid/stalled', { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  const [, socket] = await connected as [unknown, Socket];
  // CONNECT hands out a half-open socket: finish our side after the client closes.
  socket.on('end', () => socket.end());
  socket.resume();
  const closed = once(socket, 'close');
  controller.abort();
  await rejected;
  await outbound.close();
  await closed;
  assert.equal(socket.destroyed, true);
});
