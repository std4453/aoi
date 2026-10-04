import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
// Local development adapter uses the same independently testable raw tunnel for HTTP/HTTPS/SOCKS5.
// @ts-expect-error Local ESM adapter has no TypeScript declaration.
import { connectViaProxy, validDestination } from '../../scripts/browser-login/proxy-tunnel.mjs';

test('browser proxy accepts HTTPS DNS destinations and rejects injected or local authorities', () => {
  assert.equal(validDestination('accounts.pixiv.net:443'), 'accounts.pixiv.net');
  for (const target of ['localhost:443', '127.0.0.1:443', 'a.local:443', 'a.internal:443', 'a.test:80', 'a.test:443\r\nInjected: true']) {
    assert.throws(() => validDestination(target));
  }
});

test('browser raw CONNECT uses configured HTTP proxy auth and preserves opaque bytes', async () => {
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    const handshake = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!pending.includes('\r\n\r\n')) return;
      const request = pending.toString();
      assert.match(request, /^CONNECT accounts\.pixiv\.net:443 HTTP\/1\.1/);
      assert.ok(request.includes(`Proxy-Authorization: Basic ${Buffer.from('test:password').toString('base64')}`));
      socket.off('data', handshake); socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      socket.on('data', bytes => socket.write(bytes));
    };
    socket.on('data', handshake);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const address = proxy.address() as net.AddressInfo;
    const socket = await connectViaProxy('accounts.pixiv.net:443', `http://test:password@127.0.0.1:${address.port}`);
    const received = new Promise<Buffer>(resolve => socket.once('data', resolve));
    socket.resume(); socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x01]));
    assert.deepEqual(await received, Buffer.from([0x16, 0x03, 0x01, 0x00, 0x01]));
    socket.destroy();
  } finally { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

test('browser raw tunnel performs authenticated SOCKS5 with remote DNS', async () => {
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let stage = 0;
    socket.on('data', bytes => {
      if (stage === 0) { assert.deepEqual(bytes, Buffer.from([5, 1, 2])); socket.write(Buffer.from([5, 2])); }
      else if (stage === 1) { assert.equal(bytes[0], 1); socket.write(Buffer.from([1, 0])); }
      else if (stage === 2) {
        assert.equal(bytes[3], 3); assert.equal(bytes.subarray(5, 5 + bytes[4]).toString(), 'accounts.pixiv.net');
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187]));
      } else socket.write(bytes);
      stage++;
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const socket = await connectViaProxy('accounts.pixiv.net:443', `socks5://test:password@127.0.0.1:${(proxy.address() as net.AddressInfo).port}`);
    const received = new Promise<Buffer>(resolve => socket.once('data', resolve));
    socket.resume(); socket.write('opaque'); assert.equal((await received).toString(), 'opaque'); socket.destroy();
  } finally { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});
