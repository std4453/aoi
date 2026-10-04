import assert from 'node:assert/strict';
import test from 'node:test';
import { MockAgent } from 'undici';
import { FanboxClient } from '../src/services/fanbox-client.js';
import { FanboxChallengeClient } from '../src/services/fanbox-challenge.js';
import { readExternalConfig } from '../src/config/external-sources.js';

const api = 'https://api.fanbox.cc';
const solver = 'http://127.0.0.1:43132';
const pathname = '/post.info?postId=123';
const jsonHeaders = { 'content-type': 'application/json' };
const envelope = { body: { post: { id: '123', title: 'Sample & <test>', creatorId: 'sample', body: { images: [] } } } };
const html = (value: unknown) => `<html><body><pre>${JSON.stringify(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`;
const result = (value: unknown = envelope) => ({ status: 'ok', solution: { url: api + pathname, status: 200, response: html(value), cookies: [] as unknown[] } });

function setup(enabled = true) {
  const agent = new MockAgent(); agent.disableNetConnect();
  const rotations: string[][] = [];
  const resolver = new FanboxChallengeClient(solver, 'http://proxy.test:8888/', agent);
  const client = new FanboxClient(agent, () => ({ sessionId: 'synthetic-session', source: 'settings' }),
    (previous, cookies) => { rotations.push([previous, ...cookies]); }, enabled ? resolver : undefined);
  return { agent, client, resolver, rotations };
}

test('server-managed solver proxy omits request proxy while keeping authenticated AoI outbound separate', async () => {
  const configured = readExternalConfig({ AOI_FLARESOLVERR_URL: solver, AOI_FLARESOLVERR_PROXY_MODE: 'server' }, 'http://user:password@proxy.test:8080');
  assert.equal(configured.flaresolverr.proxyUrl, undefined);
  const agent = new MockAgent(); agent.disableNetConnect();
  agent.get(solver).intercept({ path: '/v1', method: 'POST', body: body => {
    assert.equal('proxy' in JSON.parse(body), false);
    return true;
  } }).reply(200, result(), { headers: jsonHeaders });
  try {
    const resolver = new FanboxChallengeClient(configured.flaresolverr.url!, configured.flaresolverr.proxyUrl, agent);
    assert.deepEqual(await (await resolver.resolve(api + pathname, '')).json(), envelope);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('solver proxy mode preserves inheritance and rejects ambiguous configuration', () => {
  const base = { AOI_FLARESOLVERR_URL: solver };
  assert.equal(readExternalConfig(base, 'http://proxy.test:8080/').flaresolverr.proxyUrl, 'http://proxy.test:8080/');
  assert.equal(readExternalConfig({ ...base, AOI_FLARESOLVERR_PROXY_URL: 'http://override.test:8080' }, 'http://proxy.test:8080/').flaresolverr.proxyUrl, 'http://override.test:8080/');
  assert.throws(() => readExternalConfig(base, 'http://user:password@proxy.test:8080'), /without URL credentials/);
  assert.throws(() => readExternalConfig({ ...base, AOI_FLARESOLVERR_PROXY_MODE: 'server', AOI_FLARESOLVERR_PROXY_URL: 'http://proxy.test:8080' }), /cannot be combined/);
  assert.throws(() => readExternalConfig({ AOI_FLARESOLVERR_PROXY_MODE: 'server' }), /requires AOI_FLARESOLVERR_URL/);
  assert.throws(() => readExternalConfig({ ...base, AOI_FLARESOLVERR_PROXY_MODE: 'invalid' }));
});

test('disabled solver reports the challenge without another request; JSON errors never invoke it', async () => {
  for (const enabled of [false, true]) {
    const { agent, client } = setup(enabled);
    try {
      for (const status of [401, 403, 429]) {
        agent.get(api).intercept({ path: pathname }).reply(status, { error: 'private data' }, { headers: jsonHeaders });
        await assert.rejects(client.post('123'), status === 429 ? /频繁/ : /不可访问/);
      }
      if (!enabled) {
        agent.get(api).intercept({ path: pathname }).reply(403, '<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
        await assert.rejects(client.post('123'), /拦截了服务器请求/);
      }
      agent.assertNoPendingInterceptors();
    } finally { await agent.close(); }
  }
});

test('one metadata fallback uses the configured proxy and cookie, parses escaped JSON and whitelists rotation', async () => {
  const { agent, client, rotations } = setup();
  agent.get(api).intercept({ path: pathname }).reply(403, '<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
  const response = result();
  response.solution.cookies = [
    { name: 'FANBOXSESSID', value: 'synthetic-next', domain: '.fanbox.cc', path: '/' },
    { name: 'FANBOXSESSID', value: 'wrong-host', domain: 'evil.test', path: '/' },
    { name: 'PHPSESSID', value: 'unrelated', domain: '.fanbox.cc', path: '/' },
    { name: 'FANBOXSESSID', value: 'expired', domain: '.fanbox.cc', path: '/', expiry: 1 },
  ];
  agent.get(solver).intercept({ path: '/v1', method: 'POST', body: body => {
    const request = JSON.parse(body as string);
    assert.equal(request.url, api + pathname);
    assert.equal(request.session, undefined);
    assert.equal(request.maxTimeout, 60_000);
    assert.equal(request.disableMedia, true);
    assert.equal(request.returnScreenshot, false);
    assert.deepEqual(request.proxy, { url: 'http://proxy.test:8888' });
    assert.equal(request.cookies.length, 1);
    assert.equal(request.cookies[0].name, 'FANBOXSESSID');
    assert.equal(request.cookies[0].value, 'synthetic-session');
    return true;
  } }).reply(200, response, { headers: jsonHeaders });
  try {
    assert.equal((await client.post('123')).title, 'Sample & <test>');
    assert.deepEqual(rotations, [['synthetic-session', 'FANBOXSESSID=synthetic-next; Domain=.fanbox.cc; Path=/; Secure']]);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('HTTP 200 HTML and 503 challenge fallback work, but resource downloads never go to the solver', async () => {
  const { agent, client } = setup();
  try {
    for (const status of [200, 503]) {
      agent.get(api).intercept({ path: pathname }).reply(status, '<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
      agent.get(solver).intercept({ path: '/v1', method: 'POST' }).reply(200, result(), { headers: jsonHeaders });
      assert.equal((await client.post('123')).media.length, 0);
    }
    agent.get('https://downloads.fanbox.cc').intercept({ path: '/sample.png' }).reply(403, '<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
    await assert.rejects(client.download({ url: 'https://downloads.fanbox.cc/sample.png', category: 'image', extension: '.png' }, '/unused', 100), /拦截了服务器请求/);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('solver success cannot conceal redirects, HTML, malformed data, restricted posts or secrets', async () => {
  const { agent, client, resolver } = setup();
  try {
    for (const response of [
      { ...result(), status: 'error', message: 'synthetic-secret' },
      { status: 'ok', solution: { ...result().solution, url: 'https://evil.test/' } },
      { status: 'ok', solution: { ...result().solution, response: '<html>still blocked</html>' } },
      { status: 'ok', solution: { ...result().solution, response: '<pre>{"unexpected":true}</pre>' } },
    ]) {
      agent.get(solver).intercept({ path: '/v1', method: 'POST' }).reply(200, response, { headers: jsonHeaders });
      await assert.rejects(resolver.resolve(api + pathname, ''), error => error instanceof Error && /FlareSolverr/.test(error.message) && !/synthetic-secret|evil.test/.test(error.message));
    }
    agent.get(api).intercept({ path: pathname }).reply(403, '', { headers: { 'cf-mitigated': 'challenge' } });
    agent.get(solver).intercept({ path: '/v1', method: 'POST' }).reply(200, result({ error: 'synthetic-private', body: null }), { headers: jsonHeaders });
    await assert.rejects(client.post('123'), /不可访问/);
    await assert.rejects(resolver.resolve('https://elsewhere.test/', ''), /FlareSolverr/);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('cancellation is preserved and concurrent solves do not start another browser', async () => {
  const { agent, resolver } = setup();
  agent.get(solver).intercept({ path: '/v1', method: 'POST' }).reply(200, result(), { headers: jsonHeaders }).delay(100);
  const controller = new AbortController();
  const pending = resolver.resolve(api + pathname, '', controller.signal);
  try {
    await assert.rejects(resolver.resolve(api + pathname, ''), /正在进行/);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(resolver.resolve(api + pathname, ''), /正在进行/);
  } finally { await agent.close(); }
});
