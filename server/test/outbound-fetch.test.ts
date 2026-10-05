import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { createOutboundFetch, parseProxyUrl } from '~/services/outbound-fetch';

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

/** Minimal offline SOCKS5 server: parses fragmented greeting, optional auth and CONNECT. */
async function socksProxy(targetPort: number, reject = false, authenticate = false) {
  const { createServer: createTcpServer } = await import('node:net');
  const sockets = new Set<Socket>();
  const commands: Array<{ host: string; port: number }> = [];
  let authentications = 0;
  const server = createTcpServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        assert.equal(buffer[0], 5);
        assert.ok(buffer.subarray(2, 2 + buffer[1]).includes(authenticate ? 2 : 0));
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, authenticate ? 2 : 0]));
        stage = authenticate ? 'auth' : 'connect';
      }
      if (stage === 'auth') {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
        const usernameLength = buffer[1]; const passwordLength = buffer[2 + usernameLength];
        if (buffer.length < 3 + usernameLength + passwordLength) return;
        assert.equal(buffer[0], 1);
        assert.equal(buffer.subarray(2, 2 + usernameLength).toString(), 'test-user');
        assert.equal(buffer.subarray(3 + usernameLength, 3 + usernameLength + passwordLength).toString(), 'test-password');
        buffer = buffer.subarray(3 + usernameLength + passwordLength); authentications++;
        socket.write(Buffer.from([1, 0])); stage = 'connect';
      }
      if (stage !== 'connect' || buffer.length < 5) return;
      assert.equal(buffer[0], 5); assert.equal(buffer[1], 1);
      const addressLength = buffer[3] === 1 ? 4 : buffer[3] === 3 ? buffer[4] + 1 : 16;
      if (buffer.length < 6 + addressLength) return;
      const host = buffer[3] === 1 ? [...buffer.subarray(4, 8)].join('.') : buffer.subarray(5, 4 + addressLength).toString();
      const port = buffer.readUInt16BE(4 + addressLength);
      commands.push({ host, port }); stage = 'tunnel';
      const reply = Buffer.from([5, reject ? 5 : 0, 0, 1, 127, 0, 0, 1, 0, 0]);
      if (reject) { socket.end(reply); return; }
      assert.equal(port, targetPort);
      const remainder = buffer.subarray(6 + addressLength);
      const upstream = connect(targetPort, '127.0.0.1'); sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream)); upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
      socket.removeListener('data', receive);
      upstream.on('connect', () => { socket.write(reply); if (remainder.length) upstream.write(remainder); socket.pipe(upstream).pipe(socket); });
    };
    socket.on('data', receive);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `socks5://${authenticate ? 'test-user:test-password@' : ''}127.0.0.1:${address.port}`, commands, authentications: () => authentications,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const authenticate of [false, true]) {
  test(`SOCKS5 handshake and data forwarding${authenticate ? ' with credentials' : ''}`, { timeout: 7000 }, async t => {
    let targetRequests = 0;
    const target = await serve(createServer((request, response) => {
      targetRequests++;
      assert.equal(request.url, '/socks'); assert.equal(request.headers['proxy-authorization'], undefined);
      response.end('through SOCKS5');
    })); t.after(() => target.close());
    const proxy = await socksProxy(Number(new URL(target.url).port), false, authenticate); t.after(() => proxy.close());
    const outbound = createOutboundFetch(proxy.url); t.after(() => outbound.close());
    const response = await outbound.fetch(`${target.url}/socks`);
    assert.equal(await response.text(), 'through SOCKS5');
    assert.equal(targetRequests, 1); assert.deepEqual(proxy.commands, [{ host: '127.0.0.1', port: Number(new URL(target.url).port) }]);
    assert.equal(proxy.authentications(), authenticate ? 1 : 0);
  });
}

test('SOCKS5 CONNECT rejection never falls back to a reachable direct target', { timeout: 7000 }, async t => {
  let targetRequests = 0;
  const target = await serve(createServer((_request, response) => { targetRequests++; response.end('unexpected'); })); t.after(() => target.close());
  const proxy = await socksProxy(Number(new URL(target.url).port), true); t.after(() => proxy.close());
  const outbound = createOutboundFetch(proxy.url); t.after(() => outbound.close());
  await assert.rejects(outbound.fetch(target.url));
  assert.ok(proxy.commands.length > 0); assert.equal(targetRequests, 0);
});
