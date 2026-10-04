"""Loopback-only CONNECT forwarder for this dedicated browser. Never logs traffic."""
import json
import select
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

config = json.load(open('/config/aoi-login.json'))
class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_CONNECT(self):
        upstream = None
        try:
            upstream = socket.create_connection(('host.docker.internal', config['brokerPort']), timeout=15)
            upstream.sendall(('CONNECT '+self.path+' HTTP/1.1\r\nHost: '+self.path+'\r\nProxy-Authorization: Bearer '+config['proxyToken']+'\r\n\r\n').encode())
            header = b''
            while not header.endswith(b'\r\n\r\n'):
                data = upstream.recv(1)
                if not data or len(header) > 16384: raise ValueError()
                header += data
            if not header.startswith(b'HTTP/1.1 200 '): raise ValueError()
            self.connection.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
            upstream.settimeout(None)
            while True:
                ready, _, _ = select.select([self.connection, upstream], [], [], 120)
                if not ready: break
                for source in ready:
                    data = source.recv(65536)
                    if not data: return
                    (upstream if source is self.connection else self.connection).sendall(data)
        except Exception:
            pass
        finally:
            if upstream: upstream.close()
            self.close_connection = True

ThreadingHTTPServer(('127.0.0.1', 9223), Proxy).serve_forever()
