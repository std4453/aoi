// Exercise the published runtime offline. All input and output are synthetic;
// the container has no network, credentials, post URLs or persistent volumes.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const docker = process.env.DOCKER_BIN || 'docker';
const seccomp = fileURLToPath(new URL('../browser-login/seccomp.json', import.meta.url));
const run = args => exec(docker, args, { timeout: 90000, maxBuffer: 16384 });
let id;
try {
  id = (await run(['run', '-d', '--network', 'none', '--log-driver', 'none',
    '--label', 'io.aoi.purpose=flaresolverr-smoke', '--security-opt', `seccomp=${seccomp}`,
    '--cpus', '2', '--memory', '1536m', '--shm-size', '256m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--tmpfs', '/config:rw,nosuid,nodev,size=64m,uid=1000,gid=1000',
    process.env.AOI_FLARESOLVERR_IMAGE || 'aoi-flaresolverr:local'])).stdout.trim();
  const result = await run(['exec', id, 'python', '-c', `
import http.server,json,pathlib,threading,time,urllib.request
for attempt in range(90):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8191/health',timeout=1) as r:
            assert json.load(r)['status']=='ok'
        break
    except Exception:
        time.sleep(.5)
else:
    raise RuntimeError('solver not ready')
class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(b'{"aoiSmoke":"synthetic-only"}')
server=http.server.HTTPServer(('127.0.0.1',18080),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
body=json.dumps({'cmd':'request.get','url':'http://127.0.0.1:18080/','maxTimeout':30000}).encode()
with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8191/v1',data=body,headers={'Content-Type':'application/json'}),timeout=60) as r:
    result=json.load(r)
assert result['status']=='ok'
assert result['solution']['status']==200
assert 'synthetic-only' in result['solution']['response']
assert result['solution']['url']=='http://127.0.0.1:18080/'
# Poll only process names, never arguments or profiles.
for attempt in range(40):
    names=[]
    for p in pathlib.Path('/proc').glob('[0-9]*/comm'):
        try: names.append(p.read_text().strip())
        except OSError: pass
    if not any(n in ('chromium','chromedriver') for n in names): break
    time.sleep(.1)
else: raise RuntimeError('temporary browser remained')
print('PASS offline solver startup, synthetic JSON request, browser cleanup')
`]);
  assert.match(result.stdout, /^PASS offline solver/m);
  console.log(result.stdout.trim());
} finally { if (id) await run(['rm', '-f', id]); }
