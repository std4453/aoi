import net from 'node:net';
import tls from 'node:tls';

export function validDestination(authority) {
  const match = /^([a-z0-9.-]+):443$/i.exec(authority || '');
  if (!match || !match[1].includes('.') || net.isIP(match[1]) || /(?:^|\.)(?:localhost|local|internal)$/i.test(match[1])) throw new Error('Invalid destination');
  return match[1];
}

// Raw CONNECT only: browser TLS stays end-to-end; no certificates or request bodies are inspected.
export async function connectViaProxy(authority, proxyUrl) {
  const hostname = validDestination(authority);
  const proxy = proxyUrl ? new URL(proxyUrl) : null;
  if (proxy && !['http:', 'https:', 'socks5:'].includes(proxy.protocol)) throw new Error('Invalid proxy');
  const socket = proxy?.protocol === 'https:'
    ? tls.connect({ host: proxy.hostname, port: Number(proxy.port || 443), servername: proxy.hostname })
    : net.connect(Number(proxy?.port || (proxy ? (proxy.protocol === 'socks5:' ? 1080 : 80) : 443)), proxy?.hostname || hostname);
  const timer = setTimeout(() => socket.destroy(new Error('Proxy timeout')), 15000);
  const chunks = [];
  let wake;
  let failed;
  const onData = chunk => { chunks.push(chunk); wake?.(); };
  const onError = () => { failed = true; wake?.(); };
  socket.on('data', onData); socket.on('error', onError); socket.on('end', onError);
  const read = async size => {
    while (Buffer.concat(chunks).length < size) {
      if (failed) throw new Error('Proxy failed');
      await new Promise(resolve => { wake = resolve; });
    }
    const all = Buffer.concat(chunks); chunks.length = 0;
    if (all.length > size) chunks.push(all.subarray(size));
    return all.subarray(0, size);
  };
  try {
    await new Promise((resolve, reject) => { socket.once(proxy?.protocol === 'https:' ? 'secureConnect' : 'connect', resolve); socket.once('error', reject); });
    if (proxy?.protocol === 'socks5:') {
      const auth = Boolean(proxy.username);
      socket.write(Buffer.from([5, 1, auth ? 2 : 0]));
      const hello = await read(2);
      if (hello[0] !== 5 || hello[1] !== (auth ? 2 : 0)) throw new Error('Proxy authentication failed');
      if (auth) {
        const user = Buffer.from(decodeURIComponent(proxy.username)); const password = Buffer.from(decodeURIComponent(proxy.password));
        if (user.length > 255 || password.length > 255) throw new Error('Invalid proxy credentials');
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
        if ((await read(2))[1] !== 0) throw new Error('Proxy authentication failed');
      }
      const host = Buffer.from(hostname); if (host.length > 255) throw new Error('Invalid host');
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([1, 187])]));
      const response = await read(4);
      if (response[1] !== 0) throw new Error('Proxy refused connection');
      const length = response[3] === 1 ? 4 : response[3] === 4 ? 16 : response[3] === 3 ? (await read(1))[0] : 0;
      if (!length) throw new Error('Invalid proxy response');
      await read(length + 2);
    } else if (proxy) {
      const authorization = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`);
      let header = '';
      while (!header.endsWith('\r\n\r\n')) { header += (await read(1)).toString('latin1'); if (header.length > 16384) throw new Error('Invalid proxy response'); }
      if (!/^HTTP\/1\.[01] 200\b/.test(header)) throw new Error('Proxy refused connection');
    }
    clearTimeout(timer); socket.pause(); socket.off('data', onData); socket.off('error', onError); socket.off('end', onError);
    if (chunks.length) socket.unshift(Buffer.concat(chunks));
    return socket;
  } catch { clearTimeout(timer); socket.destroy(); throw new Error('Unable to connect through configured proxy'); }
}
