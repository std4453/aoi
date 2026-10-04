import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-fanbox-auth-'));
process.env.DATA_DIR = dataDir;
process.env.FANBOX_SESSION_ID = 'environment-session';
process.env.FANBOX_COOKIES_FILE = '';
const { readFanboxSettings, saveFanboxSettings, sessionFromCookieFile, rotateFanboxSession } = await import('../src/services/fanbox-auth.js');
const { config } = await import('../src/config.js');
const { registerFanboxRoutes } = await import('../src/routes/fanbox.js');
const app = Fastify();
await app.register(registerFanboxRoutes);
test.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
const cookie = (value: string, expires = '0', domain = '.fanbox.cc') => `${domain}\tTRUE\t/\tTRUE\t${expires}\tFANBOXSESSID\t${value}`;

test('session settings reveal only on explicit request, persist privately, and clearing overrides the environment', async () => {
  assert.equal(readFanboxSettings().source, 'environment');
  const secret = 'local-session-value';
  const save = await app.inject({ method: 'PUT', url: '/api/settings/fanbox', payload: { sessionId: secret } });
  assert.equal(save.statusCode, 200);
  assert.equal(save.headers['cache-control'], 'no-store');
  assert.equal(save.body.includes(secret), false);
  assert.equal(fs.statSync(path.join(dataDir, 'fanbox-settings.json')).mode & 0o777, 0o600);
  assert.equal(readFanboxSettings().sessionId, secret);
  const read = await app.inject('/api/settings/fanbox');
  assert.deepEqual(read.json(), { configured: true, source: 'settings' });
  const revealed = await app.inject('/api/settings/fanbox?reveal=1');
  assert.deepEqual(revealed.json(), { configured: true, source: 'settings', sessionId: secret });
  assert.equal(revealed.headers['cache-control'], 'no-store');
  assert.equal(read.headers['cache-control'], 'no-store');
  for (const value of ['secret; Other=leak', 'secret\r\nInjected: true', 'secret with spaces']) {
    const rejected = await app.inject({ method: 'PUT', url: '/api/settings/fanbox', payload: { sessionId: value } });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body.includes('secret'), false);
  }
  const cleared = await app.inject({ method: 'PUT', url: '/api/settings/fanbox', payload: { sessionId: '' } });
  assert.deepEqual(cleared.json(), { configured: false, source: 'none' });
  assert.equal(readFanboxSettings().sessionId, '');
});

test('Netscape cookies enforce domain, path, expiry and unique sessions while ignoring unrelated cookies', () => {
  assert.equal(sessionFromCookieFile(`# Netscape HTTP Cookie File\n#HttpOnly_${cookie('test-session')}\n.example.test\tTRUE\t/\tTRUE\t0\tOTHER\tprivate`), 'test-session');
  for (const text of [cookie('expired', '1'), cookie('wrong-host', '0', '.fanbox.cc.evil'), cookie('wrong-domain', '0', 'www.fanbox.cc'), cookie('test').replace('\t/\t', '\t/account\t'), cookie('test').replace('TRUE', 'FALSE'), `${cookie('a')}\n${cookie('b')}`, cookie('bad;cookie')]) assert.throws(() => sessionFromCookieFile(text));
});

test('externally updated cookie files are reloaded and never overwritten by server settings or rotation', async () => {
  const filename = path.join(dataDir, 'cookies.txt');
  config.fanbox.cookiesFile = filename;
  try {
    fs.writeFileSync(filename, cookie('first'));
    assert.deepEqual(readFanboxSettings(), { sessionId: 'first', source: 'cookie_file' });
    fs.writeFileSync(filename, cookie('second'));
    assert.equal(readFanboxSettings().sessionId, 'second');
    rotateFanboxSession('second', ['FANBOXSESSID=third; Domain=.fanbox.cc; Path=/']);
    assert.equal(readFanboxSettings().sessionId, 'second');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/fanbox', payload: { sessionId: 'other' } })).statusCode, 400);
    fs.writeFileSync(filename, cookie('expired', '1'));
    assert.throws(readFanboxSettings, /Cookie 文件/);
  } finally { config.fanbox.cookiesFile = undefined; }
});

test('session rotation is persistent, domain scoped and cannot undo a user edit or logout', () => {
  saveFanboxSettings('initial');
  for (const cookie of ['FANBOXSESSID=evil; Domain=evil.test', 'FANBOXSESSID=deleted; Max-Age=0', 'FANBOXSESSID=expired; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'FANBOXSESSID=wrong-path; Path=/account', 'FANBOXSESSID=invalid value', 'FANBOXSESSID=']) rotateFanboxSession('initial', [cookie]);
  assert.equal(readFanboxSettings().sessionId, 'initial');
  rotateFanboxSession('initial', ['FANBOXSESSID=rotated; Domain=.fanbox.cc; Path=/; Secure; HttpOnly']);
  assert.equal(readFanboxSettings().sessionId, 'rotated');
  saveFanboxSettings('manual');
  rotateFanboxSession('rotated', ['FANBOXSESSID=stale; Path=/']);
  assert.equal(readFanboxSettings().sessionId, 'manual');
  saveFanboxSettings('');
  rotateFanboxSession('manual', ['FANBOXSESSID=late; Path=/']);
  assert.equal(readFanboxSettings().sessionId, '');
});
