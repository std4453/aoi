import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { ProxyAgent } from 'undici';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-mega-auth-'));
process.env.DATA_DIR = dataDir;
process.env.AOI_PROXY_URL = 'http://127.0.0.1:1';
const { registerMegaRoutes } = await import('~/routes/mega');
const { readMegaSession, readMegaSettings, expireMegaSession } = await import('~/services/mega-auth');
const { describeMegaShare, downloadMegaShare } = await import('~/services/mega-download');
const { config } = await import('~/config');
const app = Fastify();
await app.register(registerMegaRoutes);
test.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// Generated synthetic V2 login exchange, not an account or captured session.
const email = 'synthetic@example.invalid';
const password = 'synthetic login password';
const salt = Buffer.alloc(16, 31);
const masterKey = Buffer.alloc(16, 27);
const derived = pbkdf2Sync(password, salt, 100_000, 32, 'sha512');
const jwk = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'jwk' });
const number = (value: string) => BigInt(`0x${Buffer.from(value, 'base64url').toString('hex')}`);
function bytes(value: bigint): Buffer { const hex = value.toString(16); return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex'); }
function mpi(value: bigint): Buffer {
  const length = Buffer.alloc(2); length.writeUInt16BE(value.toString(2).length);
  return Buffer.concat([length, bytes(value)]);
}
function power(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  for (; exponent; exponent >>= 1n, base = base * base % modulus) if (exponent & 1n) result = result * base % modulus;
  return result;
}
function ecb(data: Buffer, key: Buffer): string {
  const padded = Buffer.alloc(Math.ceil(data.length / 16) * 16); data.copy(padded);
  const cipher = createCipheriv('aes-128-ecb', key, null); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64url');
}
const p = number(jwk.p!); const q = number(jwk.q!);
const rsa = Buffer.concat([mpi(p), mpi(q), mpi(number(jwk.d!)), mpi(power(p, q - 2n, q))]);
const sessionBytes = Buffer.alloc(43, 61);
const expectedSid = sessionBytes.toString('base64url');
const loginResponse = {
  k: ecb(masterKey, derived.subarray(0, 16)), privk: ecb(rsa, masterKey),
  csid: mpi(power(BigInt(`0x${sessionBytes.toString('hex')}`), number(jwk.e!), number(jwk.n!))).toString('base64url'),
};

test('account login uses the configured proxy, saves only sid, and never loads cloud files', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const actions: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.ok((init as RequestInit & { dispatcher: unknown }).dispatcher instanceof ProxyAgent);
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://g.api.mega.co.nz');
    assert.equal(init?.redirect, 'error');
    const request = JSON.parse(String(init?.body))[0];
    actions.push(request.a);
    if (request.a === 'us0') return Response.json([{ v: 2, s: salt.toString('base64url') }]);
    if (request.a === 'us') {
      assert.equal(request.user, email);
      assert.equal(request.uh, derived.subarray(16).toString('base64url'));
      assert.equal(request.mfa, '123456');
      return Response.json([loginResponse]);
    }
    assert.equal(request.a, 'ug');
    assert.equal(url.searchParams.get('sid'), expectedSid);
    return Response.json([{ u: 'synthetic', name: 'not persisted' }]);
  };
  const response = await app.inject({ method: 'POST', url: '/api/settings/mega/login', payload: { email, password, secondFactorCode: '123456' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { configured: true, expired: false });
  assert.deepEqual(actions, ['us0', 'us', 'ug']);
  const file = path.join(dataDir, 'mega-settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { sid: expectedSid });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const status = await app.inject('/api/settings/mega?reveal=1');
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal(status.body.includes(expectedSid), false);
  assert.equal(status.body.includes(email), false);
});

test('failed and malformed login responses preserve the saved session and return safe errors', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const failure of [-26, -9, { k: 'AA', csid: 'AA', privk: 'AA' }]) {
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body))[0];
      return Response.json([request.a === 'us0' ? { v: 2, s: salt.toString('base64url') } : failure]);
    };
    const result = await app.inject({ method: 'POST', url: '/api/settings/mega/login', payload: { email, password } });
    assert.equal(result.statusCode, 400);
    assert.doesNotMatch(result.body, /synthetic|privk|csid/);
    if (failure === -26) assert.match(result.json().error, /二次验证码/);
    assert.equal(readMegaSession()?.sid, expectedSid);
  }
});

test('saved session authenticates share metadata; expiration blocks later tasks without anonymous fallback', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('sid'), expectedSid);
    assert.equal(JSON.parse(String(init?.body))[0].a, 'g');
    return Response.json([-15]);
  };
  const url = `https://mega.nz/file/AAAAAAAA#${Buffer.alloc(32).toString('base64url')}`;
  await assert.rejects(describeMegaShare({ url }), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(readMegaSettings(), { configured: true, expired: true });
  await assert.rejects(describeMegaShare({ url }), { code: 'AUTH_REQUIRED' });
  assert.equal(requests, 1);
  const cleared = await app.inject({ method: 'DELETE', url: '/api/settings/mega' });
  assert.equal(cleared.statusCode, 200);
  assert.equal(readMegaSession(), null);
  expireMegaSession(expectedSid);
  assert.equal(readMegaSession(), null);
});

test('signed-in share downloads attach sid to tickets but never storage URLs', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { encrypt } = await import('megajs');
  const plaintext = Buffer.alloc(512, 12);
  const encoder = encrypt(Buffer.alloc(24, 14)) as unknown as NodeJS.ReadWriteStream & { key: Buffer };
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => { encoder.on('data', chunk => chunks.push(chunk)); encoder.on('end', resolve); encoder.on('error', reject); });
  encoder.end(Buffer.from(plaintext)); await done;
  const encrypted = Buffer.concat(chunks);
  const key = encoder.key;
  const attributeKey = Buffer.from(key.subarray(0, 16));
  for (let i = 0; i < 16; i++) attributeKey[i] ^= key[i + 16];
  const text = Buffer.from('MEGA{"n":"fixture.zip"}');
  const padded = Buffer.alloc(Math.ceil(text.length / 16) * 16); text.copy(padded);
  const cipher = createCipheriv('aes-128-cbc', attributeKey, Buffer.alloc(16)); cipher.setAutoPadding(false);
  const at = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64url');
  fs.writeFileSync(path.join(dataDir, 'mega-settings.json'), JSON.stringify({ sid: expectedSid }), { mode: 0o600 });
  let downloads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.ok((init as RequestInit & { dispatcher: unknown }).dispatcher instanceof ProxyAgent);
    if (url.pathname === '/cs') {
      assert.equal(url.searchParams.get('sid'), expectedSid);
      const request = JSON.parse(String(init?.body))[0];
      if (request.a === 'sml') return Response.json([0]);
      if (request.g) { assert.equal(request.v, 2); return Response.json([{ s: encrypted.length, g: 'https://storage.mega.co.nz/file' }]); }
      return Response.json([{ s: encrypted.length, at }]);
    }
    downloads++;
    assert.equal(url.search, '');
    const match = /\/(\d+)-(\d+)$/.exec(url.pathname)!;
    return new Response(encrypted.subarray(Number(match[1]), Number(match[2]) + 1));
  };
  const result = await downloadMegaShare({ url: `https://mega.nz/file/AAAAAAAA#${key.toString('base64url')}`, destination: dataDir });
  assert.deepEqual(fs.readFileSync(result.contentPath), plaintext);
  assert.equal(downloads, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/settings/mega' })).statusCode, 200);
  assert.equal(readMegaSession(), null);
});

test('MEGA download options are bounded and fixed chunks keep zero increment', async () => {
  const { readExternalConfig } = await import('~/config/external-sources');
  assert.equal(config.mega.chunkSizeIncrement, 0);
  assert.equal(config.mega.maxConnections, 8);
  for (const env of [{ MEGA_MAX_CONNECTIONS: '100' }, { MEGA_CHUNK_SIZE_INCREMENT: '-1' }, { MEGA_MAX_CHUNK_SIZE: '32', MEGA_INITIAL_CHUNK_SIZE: '64' }]) {
    assert.throws(() => readExternalConfig(env));
  }
});
