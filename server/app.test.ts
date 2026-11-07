// What each role serves (app.ts): one service as before, the owner's app behind IAP, and the public edge; and an AI
// app connecting across the two, with the page asking the owner on the app and everything else on the edge.
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import crypto from 'crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccess } from '../shared/types.js';
import { createApp } from './app.js';
import { startSession } from './auth.js';
import { DocIndex, MemoryIndexBackend, setIndexForTests } from './docIndex.js';
import { IAP_ISSUER, setIapKeysForTests } from './iap.js';
import { forgetGrants } from './oauth.js';
import { MemoryStore, setStoreForTests } from './store.js';

const AUDIENCE = '/projects/123456789012/locations/europe-west3/services/paperwork-app';
const RELAY = 'paperwork-edge@example-project.iam.gserviceaccount.com';
const GEMINI_CALLBACK = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc123-paperwork_example';
const ENV = ['APP_URL', 'PUBLIC_URL', 'ALLOWED_EMAILS', 'IAP_AUDIENCE', 'CRON_RELAY_ACCOUNT'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));

const servers: Server[] = [];
let all: string;
let appBase: string;
let edge: string;
let cookie: string;
let privateKey: CryptoKey;
let store: MemoryStore;

async function listen(app: import('express').Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  process.env.ALLOWED_EMAILS = 'me@example.com';
  process.env.IAP_AUDIENCE = AUDIENCE;
  process.env.CRON_RELAY_ACCOUNT = RELAY;
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  setIapKeysForTests(createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }] }));

  all = await listen(await createApp('all', { client: 'none' }));
  appBase = await listen(await createApp('app', { client: 'none' }));
  // Asked for the built pages, the edge still serves none
  edge = await listen(await createApp('edge', { client: 'dist' }));
  process.env.APP_URL = appBase;
  process.env.PUBLIC_URL = edge;

  const headers: string[] = [];
  await startSession({ append: (_name: string, value: string) => headers.push(value) } as any, { email: 'me@example.com', name: 'Me', picture: null });
  cookie = headers[0].split(';')[0];
});

afterAll(async () => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setIapKeysForTests(null);
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
});

beforeEach(() => {
  store = new MemoryStore();
  setStoreForTests(store);
  setIndexForTests(new DocIndex(new MemoryIndexBackend()));
  forgetGrants();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// What IAP adds to each request it lets through
async function iap(email = 'me@example.com') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, sub: 'accounts.google.com:1' }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(IAP_ISSUER).setAudience(AUDIENCE).setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
}

type Probe = [method: string, path: string, init?: { type?: string; body?: string }];

async function statusOf(base: string, [method, path, init]: Probe, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(init?.type ? { 'content-type': init.type } : {}), ...headers },
    body: init?.body,
    redirect: 'manual',
  });
  await res.arrayBuffer();
  return res.status;
}

const FORM = 'application/x-www-form-urlencoded';

describe('one service (role all)', () => {
  // Statuses taken from the server as it was before it could run as two services (same requests, same settings)
  const today: [Probe, number][] = [
    [['GET', '/health'], 200],
    [['POST', '/internal/cron'], 200],
    [['POST', '/inbound/email', { type: 'message/rfc822', body: 'x' }], 401],
    [['POST', '/csp-report', { type: 'application/csp-report', body: '{"csp-report":{}}' }], 204],
    [['GET', '/.well-known/oauth-authorization-server'], 200],
    [['GET', '/.well-known/oauth-authorization-server/mcp'], 200],
    [['GET', '/.well-known/oauth-protected-resource'], 200],
    [['GET', '/.well-known/oauth-protected-resource/mcp'], 200],
    [['OPTIONS', '/.well-known/oauth-authorization-server'], 204],
    [['POST', '/oauth/register', { type: 'application/json', body: '{}' }], 400],
    [['OPTIONS', '/oauth/register'], 204],
    [['GET', '/oauth/authorize?client_id=x'], 400],
    [['POST', '/oauth/authorize', { type: FORM, body: 'ticket=x' }], 400],
    [['OPTIONS', '/oauth/token'], 204],
    [['POST', '/oauth/token', { type: FORM, body: 'grant_type=x' }], 401],
    [['POST', '/oauth/revoke', { type: FORM, body: 'token=x' }], 200],
    [['POST', '/mcp', { type: 'application/json', body: '{}' }], 401],
    [['GET', '/mcp'], 401],
    [['OPTIONS', '/mcp'], 204],
    [['GET', '/auth/signin'], 302],
    [['GET', '/auth/connect'], 302],
    [['GET', '/auth/callback'], 302],
    [['POST', '/auth/signout'], 403],
    [['GET', '/api/session'], 200],
    [['GET', '/api/library'], 401],
    [['POST', '/api/sync'], 401],
    [['GET', '/api/mcp'], 401],
    [['GET', '/nothing-here'], 404],
  ];

  it('serves what it always served', async () => {
    const got: [string, number][] = [];
    for (const [probe] of today) got.push([`${probe[0]} ${probe[1]}`, await statusOf(all, probe)]);
    expect(got).toEqual(today.map(([probe, status]) => [`${probe[0]} ${probe[1]}`, status]));
  });
});

describe('the public edge', () => {
  it('serves no pages, no API and no sign-in, and answers nothing else either', async () => {
    for (const probe of [
      ['GET', '/'],
      ['GET', '/index.html'],
      ['GET', '/assets/x.js'],
      ['GET', '/sw.js'],
      ['GET', '/api/session'],
      ['GET', '/auth/signin'],
      ['POST', '/oauth/authorize', { type: FORM, body: 'ticket=x' }],
      ['POST', '/csp-report', { type: 'application/csp-report', body: '{}' }],
      ['GET', '/MCP'],
    ] as Probe[]) {
      expect(await statusOf(edge, probe), probe.join(' ')).toBe(404);
    }
    const res = await fetch(`${edge}/api/session`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });

  it('sends the owner’s browser on to the page in the app, with the request as it came', async () => {
    const res = await fetch(`${edge}/oauth/authorize?a=1&b=2&redirect_uri=https%3A%2F%2Fevil.example%2F`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${appBase}/oauth/authorize?a=1&b=2&redirect_uri=https%3A%2F%2Fevil.example%2F`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${edge}/oauth/authorize`, { redirect: 'manual' })).headers.get('location')).toBe(`${appBase}/oauth/authorize`);
    expect((await fetch(`${edge}/oauth/authorize?x=${'a'.repeat(8100)}`, { redirect: 'manual' })).status).toBe(400);
  });

  it('serves AI apps and the machines that call it', async () => {
    expect(await statusOf(edge, ['GET', '/health'])).toBe(200);
    expect(await statusOf(edge, ['GET', '/.well-known/oauth-authorization-server'])).toBe(200);
    expect(await statusOf(edge, ['GET', '/.well-known/oauth-protected-resource/mcp'])).toBe(200);
    expect(await statusOf(edge, ['POST', '/mcp', { type: 'application/json', body: '{}' }])).toBe(401);
    expect(await statusOf(edge, ['POST', '/oauth/token', { type: FORM, body: 'grant_type=x' }])).toBe(401);
    expect(await statusOf(edge, ['POST', '/inbound/email', { type: 'message/rfc822', body: 'x' }])).toBe(401);
    // Only for Cloud Scheduler's token (cron.test.ts), even outside production
    expect(await statusOf(edge, ['POST', '/internal/cron'])).toBe(403);
  });
});

describe('the owner’s app behind IAP', () => {
  it('serves nothing without IAP’s signed header, not even the health check', async () => {
    for (const probe of [
      ['GET', '/health'],
      ['GET', '/'],
      ['GET', '/api/session'],
      ['GET', '/auth/signin'],
      ['GET', '/oauth/authorize'],
      ['POST', '/internal/cron'],
      ['POST', '/csp-report', { type: 'application/csp-report', body: '{}' }],
      ['GET', '/mcp'],
    ] as Probe[]) {
      expect(await statusOf(appBase, probe, { cookie }), probe.join(' ')).toBe(403);
    }
  });

  it('serves the owner the app, and none of what the edge serves', async () => {
    const header = { 'x-goog-iap-jwt-assertion': await iap() };
    expect(await statusOf(appBase, ['GET', '/health'], header)).toBe(200);
    expect(await statusOf(appBase, ['GET', '/api/session'], header)).toBe(200);
    expect(await statusOf(appBase, ['GET', '/auth/signin'], header)).toBe(302);
    expect(await statusOf(appBase, ['POST', '/csp-report', { type: 'application/csp-report', body: '{}' }], header)).toBe(204);
    for (const probe of [
      ['POST', '/mcp', { type: 'application/json', body: '{}' }],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['POST', '/oauth/token', { type: FORM, body: 'grant_type=x' }],
      ['POST', '/oauth/register', { type: 'application/json', body: '{}' }],
      ['POST', '/inbound/email', { type: 'message/rfc822', body: 'x' }],
    ] as Probe[]) {
      expect(await statusOf(appBase, probe, header), probe.join(' ')).toBe(404);
    }
    // The scheduled run only for the relay (with no Drive connected here, it has nothing to do)
    expect(await statusOf(appBase, ['POST', '/internal/cron'], header)).toBe(403);
    const run = await fetch(`${appBase}/internal/cron`, { method: 'POST', headers: { 'x-goog-iap-jwt-assertion': await iap(RELAY) } });
    expect(run.status).toBe(200);
    expect(await run.json()).toEqual({ skipped: 'Google Drive is not connected' });
  });
});

describe('Finance’s read-only feed', () => {
  const FINANCE = 'finance-server@example-project.iam.gserviceaccount.com';
  // Each role as it starts with FINANCE_READER_ACCOUNT set (read when the app is made)
  async function withFeed(role: 'all' | 'app' | 'edge') {
    process.env.FINANCE_READER_ACCOUNT = FINANCE;
    try {
      return await listen(await createApp(role, { client: role === 'app' ? 'none' : 'dist' }));
    } finally {
      delete process.env.FINANCE_READER_ACCOUNT;
    }
  }

  const feed = async (base: string, email = FINANCE) => fetch(`${base}/internal/finance/contracts`, { headers: { 'x-goog-iap-jwt-assertion': await iap(email) }, redirect: 'manual' });

  beforeEach(async () => {
    const { indexedDoc } = await import('./testing/fixtures.js');
    const { getIndex } = await import('./docIndex.js');
    await getIndex().put(indexedDoc('bill', { topic: 'Electricity', title: 'Electricity bill' }));
  });

  it('is served by the app to Finance’s account once the setting names it, and to nobody else', async () => {
    const base = await withFeed('app');
    const res = await feed(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ version: 1, pending: expect.any(Number), contracts: [] });
    expect((await feed(base, 'me@example.com')).status).toBe(403);
    expect((await fetch(`${base}/internal/finance/contracts`)).status).toBe(403);
  });

  it('is off in the app without the setting: Finance’s account is refused', async () => {
    const res = await feed(appBase);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
  });

  it('is never served by one service, which has no IAP to let Finance in: 404, not the app’s page', async () => {
    const base = await withFeed('all');
    for (const path of ['/internal/finance/contracts', '/internal/finance/purchases?since=2026-01-01', '/internal/finance']) {
      const res = await fetch(`${base}${path}`, { headers: { 'x-goog-iap-jwt-assertion': await iap(FINANCE) } });
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('');
    }
  });

  it('is never served by the edge', async () => {
    const base = await withFeed('edge');
    expect((await feed(base)).status).toBe(404);
    expect((await feed(edge)).status).toBe(404);
  });
});

describe('an AI app connecting across the two', () => {
  const pkce = () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
  };

  it('learns, registers, gets its tokens and uses them on the edge, and is allowed on the app', async () => {
    store.data.set('mcp-access', { apps: ['gemini'], registrationUntil: '2999-01-01T00:00:00.000Z', openedBy: 'me@example.com', registrations: 0 });
    const metadata = await (await fetch(`${edge}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toMatchObject({
      issuer: edge,
      authorization_endpoint: `${edge}/oauth/authorize`,
      token_endpoint: `${edge}/oauth/token`,
      registration_endpoint: `${edge}/oauth/register`,
    });
    expect(await (await fetch(`${edge}/.well-known/oauth-protected-resource/mcp`)).json()).toMatchObject({ resource: `${edge}/mcp`, authorization_servers: [edge] });

    const registered = await fetch(`${edge}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Google', redirect_uris: [GEMINI_CALLBACK], token_endpoint_auth_method: 'client_secret_basic' }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_secret: string };

    // The owner's browser: to the edge, on to the app (through IAP), the page, Allow
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: GEMINI_CALLBACK, state: 'g', code_challenge: challenge, code_challenge_method: 'S256', resource: `${edge}/mcp` });
    const sent = await fetch(`${edge}/oauth/authorize?${query}`, { redirect: 'manual' });
    expect(sent.status).toBe(302);
    const header = { 'x-goog-iap-jwt-assertion': await iap(), cookie };
    const page = await fetch(sent.headers.get('location')!, { headers: header });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Connect Gemini to Paperwork?');
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1];
    const answered = await fetch(`${appBase}/oauth/authorize`, {
      method: 'POST',
      headers: { ...header, 'content-type': FORM },
      body: new URLSearchParams({ ticket, decision: 'allow' }),
      redirect: 'manual',
    });
    expect(answered.status).toBe(303);
    const back = new URL(answered.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(GEMINI_CALLBACK);
    expect(back.searchParams.get('iss')).toBe(edge);

    // Gemini's server, at the edge
    const tokens = await fetch(`${edge}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': FORM, authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, redirect_uri: GEMINI_CALLBACK, resource: `${edge}/mcp` }),
    });
    expect(tokens.status).toBe(200);
    const { access_token } = (await tokens.json()) as { access_token: string };
    const listed = await fetch(`${edge}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(listed.status).toBe(200);

    // Settings in the app gives the edge's address to add, and shows the connection
    const settings = (await (await fetch(`${appBase}/api/mcp`, { headers: header })).json()) as AiAccess;
    expect(settings.url).toBe(`${edge}/mcp`);
    expect(settings.connections).toEqual([expect.objectContaining({ name: 'Gemini', app: 'gemini', allowed: true })]);
    expect(settings.registration.open).toBe(false);
  });
});
