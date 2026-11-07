// The scheduled run in each role (cron.ts): on the edge only for Cloud Scheduler's token, then relayed (relay.ts); on
// the app only for the relay as IAP signed it; as one service as before. Google's keys for Scheduler's token are
// stood in for by a key pair made here.
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncSummary } from '../shared/types.js';
import type { RelayResult } from './relay.js';

const h = vi.hoisted(() => ({
  keys: null as unknown as import('jose').JWTVerifyGetKey,
  relay: null as unknown as () => Promise<RelayResult>,
  sync: null as unknown as (reason: string) => Promise<SyncSummary>,
  connection: null as any,
}));

// Scheduler's tokens are checked against Google's published keys (auth.ts): here, against the local pair
vi.mock('jose', async importOriginal => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, createRemoteJWKSet: () => ((header, token) => h.keys(header, token)) as JWTVerifyGetKey };
});
vi.mock('./relay.js', () => ({ relayCron: () => h.relay() }));
vi.mock('./pipeline.js', () => ({ syncVault: (reason: string) => h.sync(reason) }));
vi.mock('./google.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./google.js')>();
  return { ...actual, getConnection: async () => h.connection };
});

const { cronHandler } = await import('./cron.js');

const EDGE_URL = 'https://paperwork-123456789012.europe-west3.run.app';
const SCHEDULER = 'paperwork-scheduler@example-project.iam.gserviceaccount.com';
const ENV = ['NODE_ENV', 'K_SERVICE', 'CRON_SERVICE_ACCOUNT', 'CRON_AUDIENCE', 'APP_URL', 'PUBLIC_URL'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const SUMMARY: SyncSummary = { at: '2026-10-24T08:00:00.000Z', reason: 'schedule', filed: 1, adopted: 0, duplicates: 0, failed: 0, waiting: 0, updated: 0, indexed: 0 };

const servers: Server[] = [];
let edge: string;
let app: string;
let one: string;
let privateKey: CryptoKey;
let otherKey: CryptoKey;

async function listen(role: 'all' | 'app' | 'edge'): Promise<string> {
  const server = express();
  // Stands in for the IAP check (iap.ts), which puts who IAP let in here
  server.use((req, res, next) => {
    const principal = req.get('x-test-principal');
    if (principal) res.locals.iap = { email: 'someone@example.com', sub: '1', principal };
    next();
  });
  server.post('/internal/cron', cronHandler(role));
  const listening = server.listen(0);
  servers.push(listening);
  await new Promise(resolve => listening.once('listening', resolve));
  return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  h.keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'g1', alg: 'RS256' }] });
  edge = await listen('edge');
  app = await listen('app');
  one = await listen('all');
});

afterAll(async () => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
});

beforeEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  process.env.CRON_SERVICE_ACCOUNT = SCHEDULER;
  process.env.CRON_AUDIENCE = EDGE_URL;
  h.relay = vi.fn(async () => ({ status: 200, body: SUMMARY }));
  h.sync = vi.fn(async () => SUMMARY);
  h.connection = { ownerEmail: 'me@example.com', refreshToken: 'sealed', scope: '', connectedAt: '' };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// A token as Cloud Scheduler sends it: Google-signed, for Scheduler's account, issued for the edge
async function schedulerToken(claims: { email?: string; aud?: string; verified?: boolean } = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email ?? SCHEDULER, email_verified: claims.verified ?? true })
    .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
    .setIssuer('https://accounts.google.com')
    .setAudience(claims.aud ?? EDGE_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);
}

async function call(base: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/internal/cron`, { method: 'POST', headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('the public edge', () => {
  it('turns away a call without Cloud Scheduler’s token, also outside production', async () => {
    expect((await call(edge)).status).toBe(403);
    expect((await call(edge, { authorization: 'Bearer nonsense' })).status).toBe(403);
    // A deploy that lost NODE_ENV, and a local edge: no way around the token
    delete process.env.NODE_ENV;
    process.env.K_SERVICE = 'paperwork';
    expect((await call(edge)).status).toBe(403);
    process.env.NODE_ENV = 'development';
    delete process.env.K_SERVICE;
    expect((await call(edge)).status).toBe(403);
    expect(h.relay).not.toHaveBeenCalled();
  });

  it('turns away a token that isn’t Scheduler’s for the edge', async () => {
    for (const token of [
      await schedulerToken({}, otherKey),
      await schedulerToken({ email: 'someone@example-project.iam.gserviceaccount.com' }),
      await schedulerToken({ aud: 'https://paperwork-app-123456789012.europe-west3.run.app' }),
      await schedulerToken({ verified: false }),
    ]) {
      expect((await call(edge, { authorization: `Bearer ${token}` })).status).toBe(403);
    }
    expect(h.relay).not.toHaveBeenCalled();
  });

  it('passes Scheduler’s call on to the app and answers with the app’s summary', async () => {
    const res = await call(edge, { authorization: `Bearer ${await schedulerToken()}` });
    expect(res).toEqual({ status: 200, body: SUMMARY });
    expect(h.relay).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('tells Scheduler the run failed when the relay did', async () => {
    h.relay = vi.fn(async () => ({ status: 502, body: { error: 'relay failed', phase: 'call', status: 302 } }));
    const res = await call(edge, { authorization: `Bearer ${await schedulerToken()}` });
    expect(res).toEqual({ status: 502, body: { error: 'relay failed', phase: 'call', status: 302 } });
  });
});

describe('the owner’s app', () => {
  it('runs only for the relay', async () => {
    expect((await call(app)).status).toBe(403);
    expect((await call(app, { 'x-test-principal': 'owner' })).status).toBe(403);
    // Scheduler's own token is no way in either
    expect((await call(app, { authorization: `Bearer ${await schedulerToken()}` })).status).toBe(403);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('files the Inbox for the relay and answers with the summary', async () => {
    expect(await call(app, { 'x-test-principal': 'relay' })).toEqual({ status: 200, body: SUMMARY });
    expect(h.sync).toHaveBeenCalledWith('schedule');
  });

  it('says so when Drive isn’t connected, and when the run failed', async () => {
    h.connection = null;
    expect(await call(app, { 'x-test-principal': 'relay' })).toEqual({ status: 200, body: { skipped: 'Google Drive is not connected' } });
    h.connection = { ownerEmail: 'me@example.com', refreshToken: 'sealed', broken: false };
    h.sync = vi.fn(async () => {
      throw new Error('Drive is down');
    });
    expect(await call(app, { 'x-test-principal': 'relay' })).toEqual({ status: 500, body: { error: 'Drive is down' } });
  });
});

describe('one service', () => {
  it('runs for Scheduler’s token when deployed, as before', async () => {
    process.env.K_SERVICE = 'paperwork';
    expect((await call(one)).status).toBe(403);
    expect(await call(one, { authorization: `Bearer ${await schedulerToken()}` })).toEqual({ status: 200, body: SUMMARY });
    expect(h.relay).not.toHaveBeenCalled();
  });
});
