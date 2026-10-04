"""Read only FANBOX authentication from this disposable container's loopback CDP.

Stdlib only. Never write credentials, page contents, or request URLs to logs/files.
The sole output is a bounded JSON result consumed privately by the login broker.
"""
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import urllib.request
from urllib.parse import urlsplit

LOGIN_STATE_EXPRESSION = """(() => {
  try {
    const metadata = JSON.parse(document.querySelector('meta#metadata')?.content || '{}');
    const user = metadata.context?.user;
    return metadata.user?.isLoggedIn === true ||
      (user != null && /^(?:[1-9][0-9]*)$/.test(String(user.userId ?? '')));
  } catch { return false; }
})()"""

PIXIV_DOMAINS = {'pixiv.net', '.pixiv.net', 'accounts.pixiv.net', '.accounts.pixiv.net'}


def pixiv_cookies(client):
    cookies = client.call('Network.getCookies', {'urls': ['https://accounts.pixiv.net/', 'https://www.pixiv.net/']})['cookies']
    return [{k: c[k] for k in ('name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires') if k in c}
            for c in cookies if c['name'] == 'PHPSESSID' and c['domain'] in PIXIV_DOMAINS and c.get('secure')]


class CDP:
    def __init__(self, url):
        u = urlsplit(url)
        if u.scheme != 'ws' or u.hostname not in ('localhost', '127.0.0.1') or u.port != 9222:
            raise ValueError('invalid endpoint')
        self.sock = socket.create_connection(('127.0.0.1', 9222), timeout=8)
        self.buffer = b''
        self.serial = 0
        self.events = []
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET {u.path} HTTP/1.1\r\nHost: localhost:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        while b'\r\n\r\n' not in self.buffer:
            self.buffer += self.sock.recv(4096)
            if len(self.buffer) > 65536:
                raise ValueError('handshake too large')
        header, self.buffer = self.buffer.split(b'\r\n\r\n', 1)
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        if b' 101 ' not in header.split(b'\r\n')[0] or expected not in header:
            raise ValueError('handshake failed')

    def read(self, size):
        while len(self.buffer) < size:
            chunk = self.sock.recv(min(65536, size - len(self.buffer)))
            if not chunk:
                raise ValueError('disconnected')
            self.buffer += chunk
        result, self.buffer = self.buffer[:size], self.buffer[size:]
        return result

    def send(self, value, opcode=1):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        size = len(data)
        prefix = bytes([0x80 | opcode])
        prefix += bytes([0x80 | size]) if size < 126 else bytes([0xfe]) + struct.pack('!H', size)
        mask = os.urandom(4)
        self.sock.sendall(prefix + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(data)))

    def receive(self):
        fragments = b''
        for _ in range(100):
            first, second = self.read(2)
            length = second & 127
            if length == 126:
                length = struct.unpack('!H', self.read(2))[0]
            elif length == 127:
                length = struct.unpack('!Q', self.read(8))[0]
            if length > 1024 * 1024 or second & 128:
                raise ValueError('invalid frame')
            payload = self.read(length)
            opcode = first & 15
            if opcode == 9:
                self.send(payload, 10)
                continue
            if opcode == 8:
                raise ValueError('disconnected')
            if opcode not in (0, 1):
                continue
            fragments += payload
            if len(fragments) > 1024 * 1024:
                raise ValueError('response too large')
            if first & 128:
                return json.loads(fragments)
        raise ValueError('no response')

    def call(self, method, params=None):
        self.serial += 1
        self.send({'id': self.serial, 'method': method, 'params': params or {}})
        for _ in range(200):
            response = self.receive()
            if response.get('id') == self.serial:
                if 'error' in response:
                    raise ValueError('command failed')
                return response['result']
            if response.get('method') and len(self.events) < 200:
                self.events.append(response)
        raise ValueError('no response')


def capture():
    with urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=8) as response:
        pages = json.loads(response.read(1024 * 1024))
    for page in pages:
        url = urlsplit(page.get('url', ''))
        # FANBOX can discard return_to and land on its home page after OAuth.
        # Read only the authentication boolean from either safe landing page.
        if page.get('type') != 'page' or url.scheme != 'https' or url.hostname != 'www.fanbox.cc' or url.path not in ('/', '/user/settings'):
            continue
        client = CDP(page['webSocketDebuggerUrl'])
        try:
            result = client.call('Runtime.evaluate', {
                'expression': LOGIN_STATE_EXPRESSION,
                'returnByValue': True,
            })
            if result.get('result', {}).get('value') is not True:
                continue
            cookies = client.call('Network.getCookies', {'urls': ['https://api.fanbox.cc/']})['cookies']
            sessions = {c['value'] for c in cookies if c['name'] == 'FANBOXSESSID' and c['domain'] in ('.fanbox.cc', 'fanbox.cc', 'api.fanbox.cc', '.api.fanbox.cc') and c['path'] == '/' and c.get('secure')}
            if len(sessions) != 1:
                continue
            return {'sessionId': sessions.pop(), 'cookies': pixiv_cookies(client)}
        finally:
            client.sock.close()
    return {'error': 'not_logged_in'}


if __name__ == '__main__':
    try:
        print(json.dumps(capture()))
    except Exception:
        print(json.dumps({'error': 'browser_unavailable'}))
        sys.exit(1)
