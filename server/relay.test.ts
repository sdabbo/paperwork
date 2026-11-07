// The edge passing the scheduled run on to the app through IAP (relay.ts), against stand-ins for Google's metadata
// server, IAM Credentials and the app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_TIMEOUT_MS, forgetRelayToken, relayCron } from './relay.js';

// undici as relay.ts uses it, noting the dispatchers it makes and passing its requests to fakeFetch below
const undici = vi.hoisted(() => ({ agents: [] as { agent: unknown; options: unknown }[], fetch: null as unknown as typeof fetch }));
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  class Agent extends actual.Agent {
    constructor(options?: ConstructorParameters<typeof actual.Agent>[0]) {
      super(options);
      undici.agents.push({ agent: this, options });
    }
  }
  return { ...actual, Agent, fetch: (input: string, init: RequestInit) => undici.fetch(input, init) };
});

const APP_URL = 'https://paperwork-app-123456789012.europe-west3.run.app';
const RELAY = 'paperwork-edge@example-project.iam.gserviceaccount.com';
const ACCESS_TOKEN = 'ya29.metadata-access-token-secret';
const SIGNED_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJlZGdlIn0.signature-secret';
const NOW = Date.parse('2026-10-24T08:00:00Z');
const SUMMARY = { at: '2026-10-24T08:00:01.000Z', reason: 'schedule', filed: 2, adopted: 0, duplicates: 1, failed: 0, waiting: 0, updated: 0, indexed: 3 };

type Phase = 'metadata' | 'signJwt' | 'call';
interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[];
let answers: Record<Phase, () => Response>;
let logged: string[];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, init: init ?? {} });
  if (url.startsWith('http://metadata.google.internal/')) return answers.metadata();
  if (url.startsWith('https://iamcredentials.googleapis.com/')) return answers.signJwt();
  if (url.startsWith(APP_URL)) return answers.call();
  throw new Error(`Unexpected request to ${url}`);
};

const callsTo = (phase: Phase) =>
  calls.filter(c => (phase === 'metadata' ? c.url.startsWith('http://metadata') : phase === 'signJwt' ? c.url.includes('iamcredentials') : c.url.startsWith(APP_URL)));
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

beforeEach(() => {
  process.env.APP_URL = APP_URL;
  process.env.CRON_RELAY_ACCOUNT = RELAY;
  delete process.env.CRON_RELAY_AUDIENCE;
  forgetRelayToken();
  calls = [];
  answers = {
    metadata: () => json(200, { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' }),
    signJwt: () => json(200, { keyId: 'key-1', signedJwt: SIGNED_JWT }),
    call: () => json(200, SUMMARY),
  };
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
});

afterEach(() => {
  delete process.env.APP_URL;
  delete process.env.CRON_RELAY_ACCOUNT;
  delete process.env.CRON_RELAY_AUDIENCE;
});

const relay = (now = NOW) => relayCron({ fetch: fakeFetch, now: () => now });
undici.fetch = fakeFetch;

describe('a relayed run', () => {
  it('gets the edge’s token, has a JWT signed for the app’s address and calls the app with it', async () => {
    const result = await relay();
    expect(result).toEqual({ status: 200, body: SUMMARY });

    const [metadata] = callsTo('metadata');
    expect(metadata.url).toBe('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
    expect(header(metadata, 'metadata-flavor')).toBe('Google');

    const [sign] = callsTo('signJwt');
    expect(sign.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${RELAY}:signJwt`);
    expect(sign.init.method).toBe('POST');
    expect(header(sign, 'authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    const claims = JSON.parse(JSON.parse(String(sign.init.body)).payload);
    const iat = Math.floor(NOW / 1000);
    expect(claims).toEqual({ iss: RELAY, sub: RELAY, aud: `${APP_URL}/internal/cron`, iat, exp: iat + 300 });

    const [call] = callsTo('call');
    expect(call.url).toBe(`${APP_URL}/internal/cron`);
    expect(call.init.method).toBe('POST');
    expect(header(call, 'authorization')).toBe(`Bearer ${SIGNED_JWT}`);
    expect(call.init.redirect).toBe('manual');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(CALL_TIMEOUT_MS).toBeLessThan(600_000);
  });

  it('waits for the app’s answer as long as the run may take, not the 300 s Node’s fetch waits for headers', async () => {
    // As on Cloud Run: through undici's fetch, which takes a dispatcher
    expect(await relayCron({ now: () => NOW })).toEqual({ status: 200, body: SUMMARY });
    const [call] = callsTo('call');
    const dispatcher = (call.init as RequestInit & { dispatcher?: unknown }).dispatcher;
    const made = undici.agents.find(a => a.agent === dispatcher);
    expect(made?.options).toMatchObject({ headersTimeout: CALL_TIMEOUT_MS, bodyTimeout: CALL_TIMEOUT_MS });
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(300_000);
  });

  it('signs for another audience when CRON_RELAY_AUDIENCE says so', async () => {
    process.env.CRON_RELAY_AUDIENCE = `${APP_URL}/*`;
    await relay();
    expect(JSON.parse(JSON.parse(String(callsTo('signJwt')[0].init.body)).payload).aud).toBe(`${APP_URL}/*`);
  });

  it('keeps the metadata server’s token until a minute before it runs out, and gets a new JWT every time', async () => {
    await relay();
    await relay(NOW + 30 * 60_000);
    expect(callsTo('metadata')).toHaveLength(1);
    expect(callsTo('signJwt')).toHaveLength(2);
    await relay(NOW + 3599_000 - 30_000);
    expect(callsTo('metadata')).toHaveLength(2);
  });

  it('gets a new token after IAM Credentials refused the one it had', async () => {
    answers.signJwt = () => json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
    expect((await relay()).status).toBe(502);
    answers.signJwt = () => json(200, { keyId: 'key-1', signedJwt: SIGNED_JWT });
    expect((await relay()).status).toBe(200);
    expect(callsTo('metadata')).toHaveLength(2);
  });

  it('logs one line per step, with the app’s summary', async () => {
    await relay();
    const lines = logged.map(line => JSON.parse(line));
    expect(lines.map(l => [l.message, l.phase, l.severity])).toEqual([
      ['Cron relay', 'metadata', 'INFO'],
      ['Cron relay', 'signJwt', 'INFO'],
      ['Cron relay', 'call', 'INFO'],
    ]);
    expect(lines[1]).toMatchObject({ account: RELAY, audience: `${APP_URL}/internal/cron`, keyId: 'key-1' });
    expect(lines[2]).toMatchObject({ status: 200, summary: { filed: 2, duplicates: 1, failed: 0, waiting: 0, indexed: 3 } });
  });
});

describe('a relay that fails', () => {
  const cases: [string, Partial<Record<Phase, () => Response>>, Phase, number][] = [
    ['the metadata server refuses', { metadata: () => json(500, { error: 'internal' }) }, 'metadata', 500],
    ['the metadata server gives no token', { metadata: () => json(200, { expires_in: 3599 }) }, 'metadata', 200],
    ['the metadata server is unreachable', { metadata: () => { throw new TypeError('fetch failed'); } }, 'metadata', 0],
    ['IAM Credentials refuses (no Token Creator role)', { signJwt: () => json(403, { error: { code: 403, message: `Permission 'iam.serviceAccounts.signJwt' denied` } }) }, 'signJwt', 403],
    ['IAM Credentials answers without a JWT', { signJwt: () => json(200, { keyId: 'key-1' }) }, 'signJwt', 200],
    ['IAP sends it to Google’s sign-in', { call: () => new Response('', { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' } }) }, 'call', 302],
    ['IAP refuses it', { call: () => new Response('Invalid IAP credentials: JWT audience doesn’t match', { status: 401, headers: { 'x-goog-iap-generated-response': 'true' } }) }, 'call', 401],
    ['the app refuses it', { call: () => new Response('Forbidden', { status: 403 }) }, 'call', 403],
    ['the app fails', { call: () => json(500, { error: 'Drive is down' }) }, 'call', 500],
    ['the app answers with a page', { call: () => new Response('<html>…</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }, 'call', 200],
    ['the app takes too long', { call: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } }, 'call', 0],
  ];

  for (const [what, failing, phase, status] of cases) {
    it(`says which step failed when ${what}`, async () => {
      Object.assign(answers, failing);
      expect(await relay()).toEqual({ status: 502, body: { error: 'relay failed', phase, status } });
      const last = JSON.parse(logged[logged.length - 1]);
      expect(last).toMatchObject({ severity: 'ERROR', message: 'Cron relay', phase, status });
    });
  }

  it('logs what IAP answered, so the reason can be read', async () => {
    answers.call = () => new Response('Invalid IAP credentials', { status: 401, headers: { 'x-goog-iap-generated-response': 'true', 'www-authenticate': 'Bearer realm="iap"' } });
    await relay();
    expect(JSON.parse(logged[logged.length - 1])).toMatchObject({ iapGenerated: 'true', wwwAuthenticate: 'Bearer realm="iap"', body: 'Invalid IAP credentials' });
    answers.call = () => new Response('', { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth' } });
    await relay();
    expect(JSON.parse(logged[logged.length - 1])).toMatchObject({ location: 'https://accounts.google.com/o/oauth2/v2/auth' });
  });

  it('never logs the token or the JWT, even when an answer repeats them', async () => {
    answers.call = () => new Response(`Rejected token ${SIGNED_JWT} from ${ACCESS_TOKEN}`, { status: 401 });
    await relay();
    answers.signJwt = () => json(403, { error: `no for ${ACCESS_TOKEN}` });
    await relay();
    answers.metadata = () => json(200, { access_token: ACCESS_TOKEN });
    forgetRelayToken();
    await relay();
    expect(logged.length).toBeGreaterThan(5);
    for (const line of logged) {
      expect(line).not.toContain(ACCESS_TOKEN);
      expect(line).not.toContain(SIGNED_JWT);
    }
    expect(logged.join('\n')).toContain('[redacted]');
  });

  it('fails without CRON_RELAY_ACCOUNT, without asking Google to sign anything', async () => {
    delete process.env.CRON_RELAY_ACCOUNT;
    expect(await relay()).toEqual({ status: 502, body: { error: 'relay failed', phase: 'signJwt', status: 0 } });
    expect(callsTo('signJwt')).toHaveLength(0);
    expect(callsTo('call')).toHaveLength(0);
  });
});
