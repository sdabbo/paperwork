// The check of Google's Identity-Aware Proxy in front of the owner's app: what IAP signed is let in, as the owner, as
// the scheduled run or as Finance reading its feed, and nothing else; with Google's keys stood in for by a key pair
// made here.
import type { AddressInfo } from 'net';
import http, { type Server } from 'http';
import express from 'express';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_PATHS, IAP_ISSUER, iapGate } from './iap.js';

const AUDIENCE = '/projects/123456789012/locations/europe-west3/services/paperwork-app';
const RELAY = 'paperwork-edge@example-project.iam.gserviceaccount.com';

let server: Server;
let base: string;
let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keysFail = false;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('ES256')).privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }] });

  const app = express();
  app.set('case sensitive routing', true);
  app.use(
    iapGate({
      audience: AUDIENCE,
      allowedEmails: () => new Set(['owner@example.com']),
      relayAccount: RELAY,
      keys: async (header, token) => {
        if (keysFail) throw new TypeError('fetch failed');
        return keys(header, token);
      },
    })
  );
  const who = (_req: express.Request, res: express.Response) => res.json(res.locals.iap);
  app.get('/api/session', who);
  app.post('/internal/cron', who);
  app.post('/INTERNAL/CRON', who);
  app.get('/health', (_req, res) => res.send('ok'));
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

let logged: string[];

beforeEach(() => {
  keysFail = false;
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
});

// A header as IAP signs it
async function assertion(claims: { email?: string; sub?: string; iss?: string; aud?: string; exp?: number; iat?: number } = {}, key = privateKey, kid = 'k1') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email ?? 'owner@example.com', sub: claims.sub ?? 'accounts.google.com:1234' })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(claims.iss ?? IAP_ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt(claims.iat ?? now - 60)
    .setExpirationTime(claims.exp ?? now + 540)
    .sign(key);
}

async function call(method: string, path: string, header?: string) {
  const res = await fetch(`${base}${path}`, { method, headers: header ? { 'x-goog-iap-jwt-assertion': header } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('the owner', () => {
  it('is let in with what IAP signed for this app', async () => {
    const res = await call('GET', '/api/session', await assertion({ email: 'Owner@Example.com' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ email: 'owner@example.com', sub: 'accounts.google.com:1234', principal: 'owner' });
  });

  it('is let in within IAP’s 30 seconds for clocks that differ, not after', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await call('GET', '/api/session', await assertion({ exp: now - 20 }))).status).toBe(200);
    expect((await call('GET', '/api/session', await assertion({ exp: now - 40 }))).status).toBe(403);
  });

  it('may not call the scheduled run', async () => {
    expect((await call('POST', '/internal/cron', await assertion())).status).toBe(403);
  });
});

describe('anything IAP didn’t sign for this app', () => {
  it('is refused without the header, everywhere', async () => {
    for (const [method, path] of [
      ['GET', '/health'],
      ['GET', '/api/session'],
      ['POST', '/internal/cron'],
    ]) {
      const res = await call(method, path);
      expect(res.status).toBe(403);
      expect(res.text).toBe('Forbidden');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(JSON.parse(logged[0])).toMatchObject({ severity: 'WARNING', message: 'IAP check failed', reason: 'missing header', path: '/health' });
  });

  it('is refused when signed another way, by another key, or not at all', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { email: 'owner@example.com', sub: 'x', iss: IAP_ISSUER, aud: AUDIENCE, iat: now, exp: now + 300 };
    const hs256 = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new TextEncoder().encode('x'.repeat(32)));
    const none = `${b64({ alg: 'none' })}.${b64(claims)}.`;
    for (const header of [hs256, none, await assertion({}, otherKey), await assertion({}, otherKey, 'k2'), 'not a token']) {
      expect((await call('GET', '/api/session', header)).status).toBe(403);
    }
  });

  it('is refused when issued by someone else or for another service, saying what it was issued for', async () => {
    expect((await call('GET', '/api/session', await assertion({ iss: 'https://accounts.google.com' }))).status).toBe(403);
    const other = '/projects/123456789012/locations/europe-west3/services/paperwork';
    expect((await call('GET', '/api/session', await assertion({ aud: other }))).status).toBe(403);
    const line = JSON.parse(logged.at(-1)!);
    expect(line).toMatchObject({ severity: 'WARNING', message: 'IAP check failed', aud: other, iss: IAP_ISSUER });
    expect(logged.join('\n')).not.toContain('eyJ');
  });

  it('is refused for an account not allowed', async () => {
    expect((await call('GET', '/api/session', await assertion({ email: 'stranger@example.com' }))).status).toBe(403);
    expect((await call('GET', '/api/session', await assertion({ email: '' }))).status).toBe(403);
  });

  it('is refused when the app doesn’t know its audience, whatever IAP signed', async () => {
    const app = express();
    app.use(iapGate({ audience: '', allowedEmails: () => new Set(['owner@example.com']), relayAccount: RELAY, keys }));
    app.get('/api/session', (_req, res) => res.json({}));
    const unsure = app.listen(0);
    await new Promise(resolve => unsure.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(unsure.address() as AddressInfo).port}/api/session`, { headers: { 'x-goog-iap-jwt-assertion': await assertion({ aud: 'anything' }) } });
      expect(res.status).toBe(403);
    } finally {
      await new Promise(resolve => unsure.close(resolve));
    }
  });

  it('is not let in when Google’s keys can’t be fetched', async () => {
    keysFail = true;
    const res = await call('GET', '/api/session', await assertion());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });
});

describe('the scheduled run, relayed by the edge', () => {
  it('may call exactly POST /internal/cron, and nothing else', async () => {
    const relay = await assertion({ email: RELAY, sub: '1099' });
    const res = await call('POST', '/internal/cron', relay);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ email: RELAY, sub: '1099', principal: 'relay' });
    expect(logged.map(l => JSON.parse(l))).toContainEqual({ severity: 'INFO', message: 'IAP relay accepted', email: RELAY, sub: '1099' });

    expect((await call('GET', '/api/session', relay)).status).toBe(403);
    expect((await call('GET', '/internal/cron', relay)).status).toBe(403);
    expect((await call('POST', '/INTERNAL/CRON', relay)).status).toBe(403);
    expect((await call('POST', '/internal/cron/', relay)).status).toBe(403);
    expect((await call('POST', '/internal%2Fcron', relay)).status).toBe(403);
  });

  it('says once which identity IAP passed on', async () => {
    const relay = await assertion({ email: RELAY });
    await call('POST', '/internal/cron', relay);
    await call('POST', '/internal/cron', relay);
    expect(logged.filter(l => l.includes('IAP relay accepted')).length).toBeLessThanOrEqual(1);
  });
});

// Finance's read-only feed (finance.ts): its account may GET exactly two paths and nothing else, and nobody else may
// use them. Gates of their own, each answering anything it lets through with who it let through (200), so a 403 is
// always the gate's.
describe('Finance, reading the feed', () => {
  const FINANCE = 'finance-server@example-project.iam.gserviceaccount.com';
  const gates: Server[] = [];
  let feed: string;
  let listed: string;
  let off: string;

  async function gate(options: { financeAccount?: string; allowed?: string[] }) {
    const app = express();
    app.set('case sensitive routing', true);
    app.use(iapGate({ audience: AUDIENCE, allowedEmails: () => new Set(options.allowed ?? ['owner@example.com']), relayAccount: RELAY, financeAccount: options.financeAccount, keys }));
    app.use((_req, res) => res.json(res.locals.iap));
    const listening = app.listen(0);
    gates.push(listening);
    await new Promise(resolve => listening.once('listening', resolve));
    return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    feed = await gate({ financeAccount: FINANCE });
    // Should the account ever be listed as the owner's too
    listed = await gate({ financeAccount: FINANCE, allowed: ['owner@example.com', FINANCE] });
    off = await gate({});
  });

  afterAll(async () => {
    await Promise.all(gates.map(g => new Promise(resolve => g.close(resolve))));
  });

  // A request with the path exactly as written: fetch would resolve dot segments before sending
  function raw(base: string, method: string, path: string, header: string) {
    const url = new URL(base);
    return new Promise<number>((resolve, reject) => {
      const req = http.request({ host: url.hostname, port: url.port, method, path, headers: { 'x-goog-iap-jwt-assertion': header } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
  }

  const finance = () => assertion({ email: FINANCE, sub: '4242' });

  it('may GET exactly the two paths of the feed, as the principal finance', async () => {
    const header = await finance();
    for (const path of FINANCE_PATHS) {
      const got = await fetch(`${feed}${path}`, { headers: { 'x-goog-iap-jwt-assertion': header } });
      expect(got.status).toBe(200);
      expect(await got.json()).toEqual({ email: FINANCE, sub: '4242', principal: 'finance' });
    }
    // With a query string: the path is what counts
    expect((await fetch(`${feed}/internal/finance/purchases?since=2026-01-01`, { headers: { 'x-goog-iap-jwt-assertion': header } })).status).toBe(200);
  });

  it('may not use any other method on the feed', async () => {
    const header = await finance();
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(await raw(feed, method, '/internal/finance/contracts', header), method).toBe(403);
    }
  });

  it('may not use the feed’s paths in any other spelling', async () => {
    const header = await finance();
    for (const path of [
      '/internal/finance/contracts/',
      '/internal/finance/Contracts',
      '/INTERNAL/FINANCE/CONTRACTS',
      '/internal/finance%2Fcontracts',
      '/internal/finance/%63ontracts',
      '/internal/finance',
      '/internal/finance/',
      '/internal/finance/other',
    ]) {
      expect(await raw(feed, 'GET', path, header), path).toBe(403);
    }
  });

  it('may not reach anything else through dot segments or doubled slashes, which a path condition on IAP’s grant lets through', async () => {
    const header = await finance();
    for (const path of ['/internal/finance/../api/session', '/internal/finance/contracts/..', '/internal/finance/./contracts', '//internal/finance/contracts', '/internal//finance/contracts']) {
      expect(await raw(feed, 'GET', path, header), path).toBe(403);
    }
  });

  it('may not use the app or the scheduled run', async () => {
    const header = await finance();
    expect(await raw(feed, 'GET', '/api/session', header)).toBe(403);
    expect(await raw(feed, 'GET', '/health', header)).toBe(403);
    expect(await raw(feed, 'GET', '/', header)).toBe(403);
    expect(await raw(feed, 'POST', '/internal/cron', header)).toBe(403);
    expect(logged.map(l => JSON.parse(l))).toContainEqual(expect.objectContaining({ message: 'IAP check failed', reason: 'the finance account may only read the feed', path: '/api/session' }));
  });

  it('is still only Finance, should its account also be listed as the owner’s', async () => {
    const header = await finance();
    expect(await raw(listed, 'GET', '/api/session', header)).toBe(403);
    const res = await fetch(`${listed}/internal/finance/contracts`, { headers: { 'x-goog-iap-jwt-assertion': header } });
    expect((await res.json()).principal).toBe('finance');
  });

  it('is refused everywhere while the feed is off', async () => {
    const header = await finance();
    for (const [method, path] of [
      ['GET', '/internal/finance/contracts'],
      ['GET', '/internal/finance/purchases'],
      ['GET', '/api/session'],
      ['POST', '/internal/cron'],
    ]) {
      expect(await raw(off, method, path, header), `${method} ${path}`).toBe(403);
    }
  });

  it('keeps the owner and the scheduled run off the feed, in any spelling', async () => {
    const owner = await assertion();
    const relay = await assertion({ email: RELAY });
    for (const base of [feed, listed, off]) {
      for (const [method, path] of [
        ['GET', '/internal/finance/contracts'],
        ['HEAD', '/internal/finance/contracts'],
        ['GET', '/internal/finance/purchases'],
        ['GET', '/INTERNAL/FINANCE/CONTRACTS'],
        ['GET', '/internal/Finance/contracts'],
        ['GET', '/internal%2Ffinance/contracts'],
        ['GET', '//internal/finance/contracts'],
        ['GET', '/internal//finance/contracts'],
        ['GET', '/internal/finance'],
      ]) {
        expect(await raw(base, method, path, owner), `owner ${method} ${path}`).toBe(403);
        expect(await raw(base, method, path, relay), `relay ${method} ${path}`).toBe(403);
      }
    }
    // Everywhere else the owner is let in as before
    expect(await raw(feed, 'GET', '/api/session', owner)).toBe(200);
    expect(logged.map(l => JSON.parse(l))).toContainEqual(expect.objectContaining({ reason: 'the feed is for the finance account only', email: 'owner@example.com' }));
  });

  it('says once that Finance was let in, never with the token', async () => {
    const header = await finance();
    const fresh = await gate({ financeAccount: FINANCE });
    for (let i = 0; i < 3; i++) await fetch(`${fresh}/internal/finance/contracts`, { headers: { 'x-goog-iap-jwt-assertion': header } });
    const accepted = logged.map(l => JSON.parse(l)).filter(l => l.message === 'IAP finance accepted');
    expect(accepted).toEqual([{ severity: 'INFO', message: 'IAP finance accepted', email: FINANCE, sub: '4242' }]);
    expect(logged.join('\n')).not.toContain(header);
    expect(logged.join('\n')).not.toContain('eyJ');
  });
});
