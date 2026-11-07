// AI apps and the MCP server: connecting with the owner's permission (oauth.ts), then searching and reading the
// documents with links into Paperwork (mcp.ts). Served over HTTP as in server.ts, against an in-memory Google Drive
// (testing/fakeDrive.ts), and used through the official MCP client as Claude or ChatGPT would.
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { Client, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client';
import type { OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccess, AttachResult, CategoryInfo, NewAiClient, SubfolderInfo } from '../shared/types.js';
import { WINDOW_MS } from './aiApps.js';
import { FakeDrive } from './testing/fakeDrive.js';
import { MemoryStore, getStore, setStoreForTests } from './store.js';
import { DocIndex, MemoryIndexBackend, getIndex, setIndexForTests } from './docIndex.js';
import type { Classification, ClassifyInput } from './classify.js';
import type { DocMeta } from './metadata.js';
import { billMeta, docLabels, prose, textPdf, wordVector } from './testing/fixtures.js';

const h = vi.hoisted(() => ({
  fake: null as unknown as import('./testing/fakeDrive.js').FakeDrive,
  connection: null as any,
  reconciled: 0,
}));

vi.mock('./google.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./google.js')>();
  const { Drive } = await import('./drive.js');
  return {
    ...actual,
    getDrive: () => new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch, sleep: async () => {} }),
    getConnection: async () => h.connection,
    rememberRootFolder: async (id: string) => {
      h.connection.rootFolderId = id;
    },
  };
});

vi.mock('./classify.js', () => ({
  classify: async (input: ClassifyInput): Promise<Classification> => ({ ...billMeta, category: input.fixedCategory ?? 'Bills & Receipts', text: null }),
  transcribe: async () => 'Transcribed text.',
  suggestTopicMerges: async () => [],
}));

vi.mock('./gemini.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./gemini.js')>();
  return { ...actual, embed: async (texts: string[]) => texts.map(t => wordVector(t)) };
});

// Counted, to see that the edge never fills the index
vi.mock('./sync.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./sync.js')>();
  return {
    ...actual,
    reconcile: (...args: Parameters<typeof actual.reconcile>) => {
      h.reconciled++;
      return actual.reconcile(...args);
    },
  };
});

const { apiRouter, authRouter } = await import('./routes.js');
const { mcpRouter, documentId, fetchTool, searchTool, deadlinesTool, topicsTool, companiesTool, categoriesTool, purchasesTool, contractsTool, today } = await import('./mcp.js');
const { oauthRouter, wellKnownRouter, connections, forgetGrants, redirectProblem, matchesRedirect, Shelf } = await import('./oauth.js');
const { startSession } = await import('./auth.js');
const { deriveKey } = await import('./crypto.js');
const { forgetTree, loadTree } = await import('./vault.js');
const { Drive } = await import('./drive.js');
const { fileName } = await import('./metadata.js');

let server: Server;
let base: string;
let cookie: string;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

beforeAll(async () => {
  const app = express();
  app.use('/.well-known', wellKnownRouter);
  app.use('/oauth', oauthRouter);
  app.use('/mcp', mcpRouter);
  app.use('/auth', authRouter);
  app.use('/api', apiRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.APP_URL = base;
  process.env.ALLOWED_EMAILS = 'me@example.com';
  const headers: string[] = [];
  await startSession({ append: (_name: string, value: string) => headers.push(value) } as any, { email: 'me@example.com', name: 'Me', picture: null });
  cookie = headers[0].split(';')[0];
});

afterAll(async () => {
  delete process.env.APP_URL;
  delete process.env.ALLOWED_EMAILS;
  await new Promise(resolve => server.close(resolve));
});

// Every app allowed, and the window for registering open (server/aiApps.ts), unless a test says otherwise
const openAccess = () => ({ apps: ['gemini', 'claude', 'chatgpt'], registrationUntil: '2999-01-01T00:00:00.000Z', openedBy: 'me@example.com', registrations: 0, registeredFrom: [] });

beforeEach(() => {
  h.fake = new FakeDrive();
  h.connection = { ownerEmail: 'me@example.com', refreshToken: 'sealed', scope: '', connectedAt: '' };
  const store = new MemoryStore();
  store.data.set('settings', { views: [], review: 'automatic' });
  store.data.set('mcp-access', openAccess());
  setStoreForTests(store);
  setIndexForTests(new DocIndex(new MemoryIndexBackend()));
  forgetTree();
  forgetGrants();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { cookie, 'x-paperwork': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

// ---------- Documents ----------

const insuranceMeta: DocMeta = {
  ...billMeta,
  title: 'Premium adjustment 2026',
  type: 'letter',
  correspondent: 'Allianz Versicherungs-AG',
  date: '2025-11-02',
  amount: 642.18,
  dueDate: '2025-12-01',
  deadlines: [{ date: '2025-12-01', what: 'Cancel by, if the new premium is too high', done: false }],
  tags: ['car'],
  references: 'Policy: KH-4711',
  action: null,
  summary: 'The premium of the car insurance rises for 2026.',
  topic: 'Car insurance VW Golf',
  gist: 'Premium for 2026 rises to 642.18 EUR',
};

const notaryMeta: DocMeta = {
  ...billMeta,
  title: 'Draft articles of association',
  type: 'contract',
  correspondent: 'Notar Dr. Mustermann',
  date: '2026-02-10',
  amount: null,
  dueDate: null,
  deadlines: [],
  tags: [],
  references: null,
  action: null,
  summary: 'Draft of the articles for Example UG.',
  topic: 'Example UG formation',
  gist: 'Draft articles sent for review',
  needsReview: true,
};

// Files documents into their folders in Drive, as filing would, and reads them into the index
async function fileDocuments() {
  const drive = new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch });
  await loadTree(drive);
  const root = h.fake.find('Paperwork')!;
  const folder = (name: string) => h.fake.childrenOf(root.id).find(f => f.name === name)!;
  const add = async (meta: DocMeta, category: string, pages: string[]) => {
    const name = fileName(meta, { name: 'scan.pdf', mimeType: 'application/pdf' });
    return h.fake.add({ name, parents: [folder(category).id], ...docLabels(meta, name), content: await textPdf(pages) });
  };
  const bill = await add(billMeta, 'Bills & Receipts', ['Stadtwerke Musterstadt Strom Rechnung März. Zählerstand 4711 kWh. ' + prose(10)]);
  // Long enough to be read in parts
  const longText = Array.from({ length: 8 }, (_, i) => prose(60, i + 2));
  const insurance = await add(insuranceMeta, 'Insurance', ['Kfz-Haftpflicht Beitrag 642,18 EUR ab 2026, Versicherungsschein KH-4711.', ...longText]);
  const notary = await add(notaryMeta, 'Legal & Government', ['Gesellschaftsvertrag der Example UG (haftungsbeschränkt), Entwurf. Gesellschafter der Example UG, Stammkapital, Geschäftsführung.']);
  const sync = await fetch(`${base}/api/sync`, { method: 'POST', headers: { cookie, 'x-paperwork': '1' } });
  expect(await sync.json()).toMatchObject({ indexed: 3 });
  return { bill, insurance, notary };
}

// ---------- An AI app, as the official client does it ----------

class TestApp implements OAuthClientProvider {
  info: StoredOAuthClientInformation | undefined;
  saved: StoredOAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | null = null;

  constructor(
    readonly redirect = CALLBACK,
    readonly name = 'Claude'
  ) {}

  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata() {
    return {
      client_name: this.name,
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return 'state-123';
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

// The owner's browser on the page asking to allow the app: returns where it is sent afterwards
async function answerConsent(url: URL | string, decision: 'allow' | 'deny' = 'allow') {
  const page = await fetch(url, { headers: { cookie }, redirect: 'manual' });
  expect(page.status).toBe(200);
  const html = await page.text();
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1];
  const answer = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, decision }),
    redirect: 'manual',
  });
  expect(answer.status).toBe(303);
  return { page, html, back: new URL(answer.headers.get('location')!) };
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

// As the owner lets an app register: Connect an AI app in Settings first (allowing an app closes the window again)
async function register(body: Record<string, unknown>) {
  await getStore().set('mcp-access', { ...(await getStore().get<object>('mcp-access')), registrationUntil: '2999-01-01T00:00:00.000Z', registrations: 0, registeredFrom: [] });
  const res = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function authorizeUrl(params: Record<string, string>) {
  const url = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

async function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// Connects an app by hand, step by step, as the specification describes it
async function connectApp(options: { method?: string } = {}) {
  const client = (await register({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: options.method ?? 'none' })).body;
  const { verifier, challenge } = pkce();
  const { back } = await answerConsent(
    authorizeUrl({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, state: 's1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp` })
  );
  const code = back.searchParams.get('code')!;
  const secret: Record<string, string> = client.client_secret ? { authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` } : {};
  const tokens = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK, resource: `${base}/mcp` }, secret);
  expect(tokens.status).toBe(200);
  return { client, code, verifier, secret, tokens: tokens.body };
}

// A request as apps speaking the 2025 protocol send it
async function rpc(accessToken: string, method: string, params: unknown) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const json = res.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').find(l => l.startsWith('data:'))?.slice(5) : text;
  return { status: res.status, headers: res.headers, body: json ? JSON.parse(json) : null };
}

const toolJson = (result: { content: unknown }) => JSON.parse((result.content as { type: string; text: string }[])[0].text);

describe('connecting an AI app', () => {
  it('connects with the owner’s permission, then searches and reads with links into Paperwork', async () => {
    const { bill, insurance, notary } = await fileDocuments();
    const app = new TestApp();
    const serverUrl = `${base}/mcp`;

    expect(await auth(app, { serverUrl })).toBe('REDIRECT');
    const { page, html, back } = await answerConsent(app.authorizationUrl!);
    expect(html).toContain('Connect Claude to Paperwork?');
    expect(html).toContain('<span class="to">claude.ai</span>');
    expect(html).toContain('me@example.com');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self' https:");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe('state-123');
    expect(back.searchParams.get('iss')).toBe(base);
    expect(await auth(app, { serverUrl, authorizationCode: back.searchParams.get('code')!, iss: back.searchParams.get('iss')! })).toBe('AUTHORIZED');

    const client = new Client({ name: 'test-app', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: app }));
    expect(client.getInstructions()).toContain('cite it as a link');
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(['fetch', 'list_categories', 'list_companies', 'list_contracts', 'list_deadlines', 'list_purchases', 'list_topics', 'search']);
    expect(tools.tools.every(t => t.annotations?.readOnlyHint)).toBe(true);

    const found = toolJson(await client.callTool({ name: 'search', arguments: { query: 'KH-4711' } }));
    expect(found.results[0]).toMatchObject({
      id: insurance.id,
      title: 'Premium adjustment 2026',
      url: `${base}/?doc=${insurance.id}`,
      company: 'Allianz Versicherungs-AG',
      topic: 'Car insurance VW Golf',
      category: 'Insurance',
      amount: '642.18 EUR',
      update: 'Premium for 2026 rises to 642.18 EUR',
      checked: true,
    });

    // By meaning, from the text: with an excerpt of what matched
    const meant = toolJson(await client.callTool({ name: 'search', arguments: { query: 'Gesellschaftsvertrag Example Entwurf' } }));
    expect(meant.results[0]).toMatchObject({ id: notary.id, checked: false, excerpt: expect.stringContaining('Gesellschaftsvertrag der Example UG') });

    const read = toolJson(await client.callTool({ name: 'fetch', arguments: { id: bill.id } }));
    expect(read).toMatchObject({ id: bill.id, title: 'Electricity bill March', url: `${base}/?doc=${bill.id}` });
    expect(read.text).toContain('Zählerstand 4711 kWh');
    expect(read.metadata).toMatchObject({ company: 'Stadtwerke Musterstadt', deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: false }] });

    // An app speaking the 2026 protocol gets the same
    const modern = new Client({ name: 'modern-app', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await modern.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: app }));
    expect(modern.getProtocolEra()).toBe('modern');
    expect(toolJson(await modern.callTool({ name: 'search', arguments: { query: 'KH-4711' } })).results[0].id).toBe(insurance.id);
    await Promise.all([client.close(), modern.close()]);

    // Settings lists the app; disconnecting it ends its access at once
    const settings = await api<AiAccess>('GET', '/mcp');
    expect(settings.body.url).toBe(serverUrl);
    expect(settings.body.connections).toEqual([
      { id: expect.any(String), name: 'Claude', host: 'claude.ai', email: 'me@example.com', connectedAt: expect.any(String), lastUsedAt: expect.any(String), app: 'claude', allowed: true },
    ]);
    const after = await api<AiAccess>('DELETE', `/mcp/connections/${settings.body.connections[0].id}`);
    expect(after.body.connections).toEqual([]);
    expect((await rpc(app.saved!.access_token, 'tools/list', {})).status).toBe(401);
  });

  it('serves apps speaking the 2025 protocol', async () => {
    const { notary } = await fileDocuments();
    const { tokens } = await connectApp();

    const init = await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old-app', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'paperwork' } });
    expect(init.body.result.instructions).toContain('Paperwork holds the user');

    const called = await rpc(tokens.access_token, 'tools/call', { name: 'search', arguments: { query: '', topic: 'example' } });
    const body = JSON.parse(called.body.result.content[0].text);
    expect(body).toMatchObject({ total: 1, results: [{ id: notary.id, title: 'Draft articles of association', topic: 'Example UG formation', checked: false }] });
  });

  it('tells an app without a token where to ask for one', async () => {
    const res = await rpc('', 'tools/list', {});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="documents:read"`);
    const bad = await rpc('not-a-token', 'tools/list', {});
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource).toEqual({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['documents:read'], bearer_methods_supported: ['header'], resource_name: 'Paperwork' });
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('sends the owner to sign in first, and back to the app’s request afterwards', async () => {
    const client = (await register({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' })).body;
    const url = authorizeUrl({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const signin = new URL(res.headers.get('location')!, base);
    expect(signin.pathname).toBe('/auth/signin');
    expect(signin.searchParams.get('next')).toBe(url.pathname + url.search);
  });

  it('answers the owner’s refusal at the app’s address, and requests it can’t take on a page of its own', async () => {
    const client = (await register({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' })).body;
    const { challenge } = pkce();
    const valid = { response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, state: 's', code_challenge: challenge, code_challenge_method: 'S256' };

    const { back } = await answerConsent(authorizeUrl(valid), 'deny');
    expect(Object.fromEntries(back.searchParams)).toMatchObject({ error: 'access_denied', state: 's', iss: base });

    // Anything else stays here: anyone may register an app, so a link to Paperwork never leads on by itself
    for (const params of [
      { ...valid, code_challenge_method: 'plain' },
      { ...valid, response_type: 'token' },
      { ...valid, resource: 'https://elsewhere.example/mcp' },
      { ...valid, redirect_uri: 'https://evil.example/cb' },
      { ...valid, client_id: 'pwc.e30.forged' },
    ]) {
      const res = await fetch(authorizeUrl(params), { headers: { cookie }, redirect: 'manual' });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('This link doesn’t work');
    }
  });

  it('only registers addresses an app can safely be sent to', async () => {
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: ['javascript:alert(1)'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: ['https://claude.ai/cb#x'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: [] })).body.error).toBe('invalid_redirect_uri');

    expect(redirectProblem('http://127.0.0.1:33418/callback')).toBeNull();
    expect(redirectProblem('cursor://anysphere.cursor-retrieval/oauth/callback')).toBeNull();
    // On this computer an app listens on whatever port is free
    expect(matchesRedirect(['http://127.0.0.1/callback'], 'http://127.0.0.1:51234/callback')).toBe(true);
    expect(matchesRedirect(['http://127.0.0.1/callback'], 'http://127.0.0.1:51234/other')).toBe(false);
    expect(matchesRedirect(['https://claude.ai/cb'], 'https://claude.ai:8443/cb')).toBe(false);

    // An address that is fine, but of no app Paperwork accepts (aiApps.ts): only Gemini, Claude and ChatGPT can be
    // allowed, and only those the owner allowed
    const cursor = await register({ client_name: 'Cursor\u0000 <b>', redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback'], token_endpoint_auth_method: 'none' });
    expect(cursor).toMatchObject({ status: 400, body: { error: 'invalid_redirect_uri', error_description: expect.stringContaining('Paperwork accepts only Gemini, Claude, ChatGPT') } });

    const registered = await register({ client_name: 'Claude\u0000 <b>', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    expect(registered.status).toBe(201);
    // Named by where its answers go, whatever it calls itself
    expect(registered.body).toMatchObject({ client_name: 'Claude', token_endpoint_auth_method: 'none' });
    expect(registered.body).not.toHaveProperty('client_secret');
    const res = await fetch(authorizeUrl({ response_type: 'code', client_id: registered.body.client_id, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' }), {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(await res.text()).toContain('Connect Claude to Paperwork?');
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self' https:");
  });
});

const GEMINI_CALLBACK = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc123-paperwork_example';

// Allows the app at the authorize address, and trades the code for tokens with the given client authentication
async function connectWith(clientId: string, redirect: string, authorization: Record<string, string>) {
  const { verifier, challenge } = pkce();
  const { html, back } = await answerConsent(
    authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 'g', code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp`, scope: 'documents:read offline_access' })
  );
  const tokens = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect }, authorization);
  return { html, back, tokens };
}

const basic = (id: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}` });

describe('apps that register differently', () => {
  it('takes Gemini’s registration, and notes each step for Settings', async () => {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    // As Gemini registers: no name, a secret asked for, scopes and grants of its own
    const registered = await register({
      client_name: 'Google',
      redirect_uris: [GEMINI_CALLBACK],
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
      response_types: ['code'],
      scope: 'documents:read offline_access',
    });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ client_name: 'Gemini', token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code', 'refresh_token'] });
    expect(registered.body.client_id).toMatch(/^pwc_[\w-]{22}$/);

    const { html, back, tokens } = await connectWith(registered.body.client_id, GEMINI_CALLBACK, basic(registered.body.client_id, registered.body.client_secret));
    expect(html).toContain('Connect Gemini to Paperwork?');
    expect(html).toContain('<span class="to">oauth-redirect.googleusercontent.com</span>');
    expect(`${back.origin}${back.pathname}`).toBe(GEMINI_CALLBACK);
    expect(tokens.status).toBe(200);
    expect((await rpc(tokens.body.access_token, 'tools/list', {})).status).toBe(200);

    const { body } = await api<AiAccess>('GET', '/mcp');
    expect(body.connections.map(c => [c.name, c.host])).toEqual([['Gemini', 'oauth-redirect.googleusercontent.com']]);
    expect(body.events.map(e => [e.app, e.ok, e.what.split(':')[0]])).toEqual([
      ['Gemini', true, 'Connected'],
      ['Gemini', true, 'Allowed by me@example.com; the code went to oauth-redirect.googleusercontent.com, for the app to trade for tokens'.split(':')[0]],
      ['Gemini', true, 'Registered itself'],
    ]);
    expect(body.events[2].what).toContain('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });

  it('answers what Paperwork doesn’t offer with what it does, and notes what it refused', async () => {
    const odd = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      // Not even said to be JSON
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ client_name: 'Odd', redirect_uris: CALLBACK, token_endpoint_auth_method: 'private_key_jwt', response_types: ['code', 'token'] }),
    });
    expect(odd.status).toBe(201);
    expect(await odd.json()).toMatchObject({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic', client_secret: expect.any(String) });

    expect((await register({ client_name: 'Evil', redirect_uris: ['http://evil.example/cb'] })).body.error).toBe('invalid_redirect_uri');
    const events = (await api<AiAccess>('GET', '/mcp')).body.events;
    expect(events[0]).toMatchObject({ ok: false, what: expect.stringContaining('Registration refused: Plain http is only allowed') });
    expect(events[0].what).toContain('http://evil.example/cb');
    expect(events[1]).toMatchObject({ app: 'Claude', ok: true, what: expect.stringContaining('it asked for "private_key_jwt"') });
  });

  it('lets an address register only so often', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await register({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' })).status);
    expect(statuses.slice(0, 30).every(s => s === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('adds an app by hand for apps that ask for a client ID and secret, and removes it with its connection', async () => {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    expect((await api<{ error: string }>('POST', '/mcp/clients', { redirectUri: 'http://evil.example/cb' })).body.error).toContain('Plain http');

    const created = await api<NewAiClient>('POST', '/mcp/clients', { redirectUri: GEMINI_CALLBACK });
    expect(created.status).toBe(200);
    const { client, secret, access } = created.body;
    expect(client).toMatchObject({ id: expect.stringMatching(/^pwc_/), name: 'Gemini', redirectUri: GEMINI_CALLBACK, host: 'oauth-redirect.googleusercontent.com' });
    expect(access.clients).toEqual([client]);

    // Wrong secret, then the right one, in the Basic header as Gemini sends it
    const { verifier, challenge } = pkce();
    const { back } = await answerConsent(authorizeUrl({ response_type: 'code', client_id: client.id, redirect_uri: GEMINI_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' }));
    const code = back.searchParams.get('code')!;
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: verifier }, basic(client.id, 'wrong'))).body.error).toBe('invalid_client');
    const tokens = await token({ grant_type: 'authorization_code', code, code_verifier: verifier }, basic(client.id, secret));
    expect(tokens.status).toBe(200);
    expect((await rpc(tokens.body.access_token, 'tools/list', {})).status).toBe(200);

    const removed = await api<AiAccess>('DELETE', `/mcp/clients/${client.id}`);
    expect(removed.body.clients).toEqual([]);
    expect(removed.body.connections).toEqual([]);
    expect((await rpc(tokens.body.access_token, 'tools/list', {})).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token }, basic(client.id, secret))).body.error).toBe('invalid_client');
  });

  it('still knows apps registered before registrations were stored, but allows none of them in again', async () => {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    // A client ID as Paperwork gave them out before: the registration itself, signed
    const key = deriveKey('mcp');
    const mac = (purpose: string, text: string) => crypto.createHmac('sha256', key).update(`${purpose}:${text}`).digest('base64url');
    const data = Buffer.from(JSON.stringify({ n: 'Claude', r: [CALLBACK], m: 'client_secret_post', t: 1792000000 })).toString('base64url');
    const id = `pwc.${data}.${mac('client', data).slice(0, 22)}`;
    // Connected then: its grant names the client ID's hash
    const gid = crypto.randomBytes(12).toString('hex');
    const refreshToken = `pwr.${gid}.${crypto.randomBytes(32).toString('base64url')}`;
    const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
    const at = new Date().toISOString();
    await getStore().set('mcp-grants', {
      grants: [{ id: gid, client: sha(id), app: 'claude', name: 'Claude', host: 'claude.ai', email: 'me@example.com', createdAt: at, lastUsedAt: at, code: null, refresh: [sha(refreshToken)] }],
    });
    expect((await token({ grant_type: 'refresh_token', refresh_token: refreshToken }, {})).body.error).toBe('invalid_client');
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: refreshToken }, basic(id, mac('secret', id)));
    expect(refreshed.status).toBe(200);
    expect((await rpc(refreshed.body.access_token, 'tools/list', {})).status).toBe(200);

    // Such an ID never expires, so it isn't allowed in again, even with the window open: the app registers anew
    const page = await fetch(authorizeUrl({ response_type: 'code', client_id: id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256' }), {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('registered with an older Paperwork');
  });
});

describe('tokens', () => {
  it('needs the code verifier, and ends the connection when a code is used twice', async () => {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    const client = (await register({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' })).body;
    const { verifier, challenge } = pkce();
    const { back } = await answerConsent(authorizeUrl({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' }));
    const code = back.searchParams.get('code')!;

    const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: client.client_id });
    expect(wrong).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const other = (await register({ client_name: 'Other', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' })).body;
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: other.client_id })).body.error).toBe('invalid_grant');

    const first = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'documents:read' });
    expect((await rpc(first.body.access_token, 'tools/list', {})).status).toBe(200);

    const again = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(again.body.error).toBe('invalid_grant');
    expect((await rpc(first.body.access_token, 'tools/list', {})).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant');
  });

  it('rotates refresh tokens, accepting the last few so an app that refreshed twice at once keeps working', async () => {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    const { client, tokens } = await connectApp();
    const refreshWith = (refresh_token: string) => token({ grant_type: 'refresh_token', refresh_token, client_id: client.client_id });

    const [a, b] = await Promise.all([refreshWith(tokens.refresh_token), refreshWith(tokens.refresh_token)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await rpc(a.body.access_token, 'tools/list', {})).status).toBe(200);
    const c = await refreshWith(a.body.refresh_token);
    expect(c.status).toBe(200);
    // Three newer ones since: the first is no longer accepted
    expect((await refreshWith(tokens.refresh_token)).body.error).toBe('invalid_grant');
    expect((await refreshWith(c.body.refresh_token)).status).toBe(200);
  });

  it('wants the secret of an app registered with one', async () => {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    const { client, secret, tokens } = await connectApp({ method: 'client_secret_basic' });
    expect(client.client_secret).toEqual(expect.any(String));
    const without = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(without).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, secret)).status).toBe(200);
    const posted = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, client_secret: client.client_secret });
    expect(posted.status).toBe(200);
  });

  it('ends the access when the app revokes it, and after 90 days unused', async () => {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    const first = await connectApp();
    const revoked = await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: first.tokens.refresh_token }) });
    expect(revoked.status).toBe(200);
    expect((await rpc(first.tokens.access_token, 'tools/list', {})).status).toBe(401);

    const second = await connectApp();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 91 * 24 * 60 * 60 * 1000);
    expect((await token({ grant_type: 'refresh_token', refresh_token: second.tokens.refresh_token, client_id: second.client.client_id })).body.error).toBe('invalid_grant');
    expect(await connections()).toEqual([]);
  });

  it('stops working for an account no longer allowed', async () => {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    const { client, tokens } = await connectApp();
    process.env.ALLOWED_EMAILS = 'someone-else@example.com';
    try {
      expect((await rpc(tokens.access_token, 'tools/list', {})).status).toBe(401);
      expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant');
    } finally {
      process.env.ALLOWED_EMAILS = 'me@example.com';
    }
  });
});

describe('a change written, then tried again', () => {
  // As Firestore does when a commit was written but its answer lost: it runs the change again, on what was written
  class RetryingStore extends MemoryStore {
    retried = new Set<string>();
    override async update<T extends object, R>(key: string, change: (current: T | null) => { next?: T; result: R }): Promise<R> {
      if (!this.retried.has(key)) return super.update(key, change);
      await super.update(key, change);
      return super.update(key, change);
    }
  }
  let store: RetryingStore;
  beforeEach(async () => {
    store = new RetryingStore();
    store.data.set('settings', { views: [], review: 'automatic' });
    store.data.set('mcp-access', openAccess());
    setStoreForTests(store);
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
  });
  const storedGrants = () => (store.data.get('mcp-grants') as { grants: { id: string; refresh: string[] }[] }).grants;

  it('keeps the app registered, allowed and connected once', async () => {
    store.retried = new Set(['mcp-clients', 'mcp-grants']);
    const client = (await register({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' })).body;
    expect((store.data.get('mcp-clients') as { clients: unknown[] }).clients).toHaveLength(1);
    const { verifier, challenge } = pkce();
    const { back } = await answerConsent(authorizeUrl({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' }));
    expect(storedGrants()).toHaveLength(1);

    const tokens = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: client.client_id });
    expect(tokens.status).toBe(200);
    expect((await rpc(tokens.body.access_token, 'tools/list', {})).status).toBe(200);
    expect(await connections()).toHaveLength(1);

    // Each refresh adds its token once, so the last few stay accepted, the oldest of them too
    const refreshWith = (refresh_token: string) => token({ grant_type: 'refresh_token', refresh_token, client_id: client.client_id });
    const first = await refreshWith(tokens.body.refresh_token);
    expect(first.status).toBe(200);
    expect(new Set(storedGrants()[0].refresh).size).toBe(storedGrants()[0].refresh.length);
    const second = await refreshWith(first.body.refresh_token);
    expect(second.status).toBe(200);
    expect(storedGrants()[0].refresh).toHaveLength(3);
    const third = await refreshWith(tokens.body.refresh_token);
    expect(third.status).toBe(200);
    expect((await rpc(third.body.access_token, 'tools/list', {})).status).toBe(200);
  });
});

describe('the tools', () => {
  it('search narrows by company, topic, category, type and dates, and says when a name matches nothing', async () => {
    const { bill, insurance, notary } = await fileDocuments();
    const ids = async (args: Parameters<typeof searchTool>[0]) => ((await searchTool(args)).results ?? []).map(r => r.id);

    expect(await ids({ query: '' })).toEqual([notary.id, insurance.id, bill.id]);
    expect(await ids({ query: '', company: 'allianz' })).toEqual([insurance.id]);
    expect(await ids({ query: '', category: 'bills' })).toEqual([bill.id]);
    expect(await ids({ query: '', type: 'contract' })).toEqual([notary.id]);
    expect(await ids({ query: '', from: '2025-06-01', to: '2025-12-31' })).toEqual([insurance.id]);
    expect(await ids({ query: '', limit: 1 })).toEqual([notary.id]);
    expect(await ids({ query: 'Stadtwerke' })).toEqual([bill.id]);
    expect(await ids({ query: 'Stadtwerke', company: 'allianz' })).toEqual([]);

    const nothing = await searchTool({ query: '', company: 'Vattenfall' });
    expect(nothing).toMatchObject({ total: 0, note: expect.stringContaining('list_companies') });
  });

  it('fetch reads a long text in parts, and takes a Paperwork link for an id', async () => {
    const { insurance } = await fileDocuments();
    const first = await fetchTool({ id: `${base}/?doc=${insurance.id}` });
    expect(first.id).toBe(insurance.id);
    expect(first.text.length).toBe(25_000);
    expect(first.metadata).toMatchObject({ next_offset: 25_000, text_chars: expect.any(Number), topic: 'Car insurance VW Golf', google_drive_url: expect.stringContaining(insurance.id) });
    const rest = await fetchTool({ id: insurance.id, offset: first.metadata.next_offset! });
    expect(first.text + rest.text).toHaveLength(first.metadata.text_chars!);
    expect(rest.metadata).not.toHaveProperty('next_offset');

    await expect(fetchTool({ id: 'nothing' })).rejects.toThrow('Paperwork has no document "nothing"');
    expect(documentId('/companies/Allianz?doc=abc_1-2')).toBe('abc_1-2');
    expect(documentId('https://x.example/?doc=../etc')).toBeNull();
  });

  it('fetch shows the folder a document is in and the files kept with it, which are no documents themselves', async () => {
    const { bill, notary } = await fileDocuments();
    // The notary's draft, in a folder for the company's opening balance sheet, with its Word file kept next to it
    const company = (await api<CategoryInfo>('POST', '/folders', { name: 'Example UG' })).body;
    const folder = (await api<SubfolderInfo>('POST', '/folders', { name: 'Eröffnungsbilanz', parentId: company.id })).body;
    expect((await api('PATCH', `/documents/${notary.id}`, { folderId: folder.id })).status).toBe(200);
    const sent = await fetch(`${base}/api/documents/${notary.id}/files`, {
      method: 'POST',
      headers: { cookie, 'x-paperwork': '1', 'x-file-name': 'Gesellschaftsvertrag.docx' },
      body: new TextEncoder().encode('draft'),
    });
    const { attachment } = (await sent.json()) as AttachResult;

    const read = await fetchTool({ id: notary.id });

    expect(read.text).toContain('Gesellschaftsvertrag der Example UG');
    expect(read.metadata).toMatchObject({
      category: 'Example UG',
      folder: 'Example UG / Eröffnungsbilanz',
      kept_files: [{ name: '2026-02-10 Notar Dr. Mustermann - Draft articles of association - Draft.docx', label: 'Draft', google_drive_url: attachment!.webViewLink }],
    });
    // One with none kept, put into its category by hand
    const other = await fetchTool({ id: bill.id });
    expect(other.metadata).toMatchObject({ folder: 'Bills & Receipts' });
    expect(other.metadata).not.toHaveProperty('kept_files');
    expect((await searchTool({ query: '', topic: 'example' })).results).toEqual([expect.objectContaining({ id: notary.id, folder: 'Example UG / Eröffnungsbilanz' })]);
    await expect(fetchTool({ id: attachment!.id })).rejects.toThrow(`Paperwork has no document "${attachment!.id}"`);

    // Read without them when Drive can't list them
    const drive = h.fake.fetch;
    h.fake.fetch = async (input, init) => (decodeURIComponent(String(input)).includes("key='pwOf'") ? new Response('{}', { status: 500 }) : drive(input, init));
    const without = await fetchTool({ id: notary.id });
    expect(without.text).toContain('Gesellschaftsvertrag der Example UG');
    expect(without.metadata).not.toHaveProperty('kept_files');
  });

  it('finds what was bought, with where, when, for how much, and until when it can be returned', async () => {
    await fileDocuments();
    const root = h.fake.find('Paperwork')!;
    const bills = h.fake.childrenOf(root.id).find(f => f.name === 'Bills & Receipts')!;
    const receiptMeta: DocMeta = {
      ...billMeta,
      title: 'Falketind hiking pants',
      type: 'receipt',
      correspondent: 'Norrøna',
      date: '2026-05-29',
      amount: 239,
      dueDate: '2026-06-28',
      deadlines: [
        { date: '2026-06-28', what: 'Last day to return', done: false, kind: 'return' },
        { date: '2028-05-29', what: 'Legal warranty ends', done: false, kind: 'warranty' },
      ],
      items: [{ name: 'Norrøna Falketind Flex1 Pants', details: 'Size M, Caviar Black', quantity: 1, price: 239, code: '1810-20 7718 M' }],
      action: null,
      summary: 'Bought at Norrøna Musterstadt.',
    };
    const name = fileName(receiptMeta, { name: 'scan.pdf', mimeType: 'application/pdf' });
    const receipt = h.fake.add({ name, parents: [bills.id], ...docLabels(receiptMeta, name), content: await textPdf(['NORRØNA Musterstadt. falketind flex1 Pants M Caviar Black 239,00 EUR. Rückgabe innerhalb von 30 Tagen. ' + prose(6)]) });
    await fetch(`${base}/api/sync`, { method: 'POST', headers: { cookie, 'x-paperwork': '1' } });

    const found = await purchasesTool({ query: 'norrona pants' });
    expect(found.purchases).toEqual([
      {
        item: 'Norrøna Falketind Flex1 Pants',
        details: 'Size M, Caviar Black',
        price: '239.00 EUR',
        code: '1810-20 7718 M',
        store: 'Norrøna',
        date: '2026-05-29',
        return_by: '2026-06-28',
        warranty_until: '2028-05-29',
        checked: true,
        receipt: { id: receipt.id, title: 'Falketind hiking pants', url: `${base}/?doc=${receipt.id}` },
      },
    ]);
    expect((await purchasesTool({ query: 'jacket' })).total).toBe(0);
    expect((await purchasesTool({ to: '2026-01-01' })).total).toBe(0);

    // Search finds the receipt by what was bought, and says so
    const searched = await searchTool({ query: 'falketind' });
    expect(searched.results?.[0]).toMatchObject({ id: receipt.id, bought: ['Norrøna Falketind Flex1 Pants (Size M, Caviar Black) 239.00 EUR'] });

    // A missed last day to return has lapsed: it isn't overdue
    const deadlines = await deadlinesTool({ from: '2026-10-01' });
    expect(deadlines.deadlines?.some(d => d.what === 'Last day to return')).toBe(false);
    expect((await deadlinesTool({ from: '2026-06-01' })).deadlines?.find(d => d.what === 'Last day to return')).toMatchObject({ kind: 'return', date: '2026-06-28' });
  });

  it('names the document a possible copy may be of, and counts its deadlines and items once until the user decides', async () => {
    const { bill } = await fileDocuments();
    const root = h.fake.find('Paperwork')!;
    const bills = h.fake.childrenOf(root.id).find(f => f.name === 'Bills & Receipts')!;
    const add = async (meta: DocMeta, text: string, properties: Record<string, string> = {}) => {
      const name = fileName(meta, { name: 'scan.pdf', mimeType: 'application/pdf' });
      const labels = docLabels(meta, name);
      return h.fake.add({ name, parents: [bills.id], ...labels, properties: { ...labels.properties, ...properties }, content: await textPdf([text]) });
    };
    // A photo of the bill, and of a receipt, each marked as a possible copy
    const photo = await add({ ...billMeta, title: 'Electricity bill March (photo)' }, 'Stadtwerke Musterstadt Strom Rechnung März, fotografiert. ' + prose(8, 3), { pwMaybeDup: bill.id });
    const receiptMeta: DocMeta = {
      ...billMeta,
      title: 'Hiking pants',
      type: 'receipt',
      correspondent: 'Norrøna',
      date: '2026-05-29',
      amount: 239,
      dueDate: null,
      deadlines: [],
      items: [{ name: 'Norrøna Falketind Flex1 Pants', details: null, quantity: 1, price: 239, code: null }],
      action: null,
    };
    const receipt = await add(receiptMeta, 'NORRØNA Musterstadt. Falketind Flex1 Pants 239,00 EUR. ' + prose(6, 4));
    await add({ ...receiptMeta, title: 'Hiking pants (photo)' }, 'NORRØNA Musterstadt, Foto. Falketind Flex1 Pants 239,00 EUR. ' + prose(6, 5), { pwMaybeDup: receipt.id });
    const sync = () => fetch(`${base}/api/sync`, { method: 'POST', headers: { cookie, 'x-paperwork': '1' } });
    await sync();

    const deadlines = await deadlinesTool({ from: '2025-04-01' });
    expect(deadlines.deadlines?.filter(d => d.date === '2025-04-25').map(d => d.document?.id)).toEqual([bill.id]);
    expect(deadlines.note).toBe('1 deadline of documents that may be copies of others is left out until the user decides; fetch shows them.');

    const listed = (await searchTool({ query: '', company: 'Stadtwerke' })).results ?? [];
    expect(listed.find(r => r.id === photo.id)).toMatchObject({ possible_duplicate_of: { id: bill.id, title: 'Electricity bill March', url: `${base}/?doc=${bill.id}` }, checked: false });
    expect(listed.find(r => r.id === bill.id)).toMatchObject({ checked: true });
    expect(listed.find(r => r.id === bill.id)).not.toHaveProperty('possible_duplicate_of');
    const fetched = await fetchTool({ id: photo.id });
    expect(fetched.metadata).toMatchObject({ possible_duplicate_of: { id: bill.id }, deadlines: [{ date: '2025-04-25' }], note: expect.stringContaining('left out of list_deadlines') });
    expect((await purchasesTool({ query: 'falketind' })).purchases?.map(p => p.receipt?.id)).toEqual([receipt.id]);

    // The original gone from Paperwork: the copy counts again
    h.fake.touch(bill.id, f => (f.trashed = true));
    await sync();
    const after = await deadlinesTool({ from: '2025-04-01' });
    expect(after.deadlines?.filter(d => d.date === '2025-04-25').map(d => d.document?.id)).toEqual([photo.id]);
    expect(after).not.toHaveProperty('note');
    expect((await searchTool({ query: '', company: 'Stadtwerke' })).results?.[0]).not.toHaveProperty('possible_duplicate_of');
  });

  it('lists the contracts as last read, with links to their topic and documents', async () => {
    const { insurance } = await fileDocuments();
    await getStore().set('contracts', {
      version: 1,
      topics: [
        {
          topic: 'Car insurance VW Golf',
          hash: 'old',
          terms: { name: 'Comprehensive car insurance', kind: 'insurance', provider: 'Allianz', reference: 'KH-1', amount: 53.52, currency: 'EUR', interval: 'month', since: null, renewal: 'year', renews: '2099-01-01', notice: '1 month', noticePeriod: { count: 1, unit: 'month' }, cancelBy: null, status: 'active', endsOn: null, latest: 'Premium rises', documentIds: [insurance.id] },
        },
      ],
    });

    const listed = await contractsTool({});
    expect(listed.contracts).toEqual([
      {
        name: 'Comprehensive car insurance',
        kind: 'Insurance',
        provider: 'Allianz',
        reference: 'KH-1',
        price: '53.52 EUR per month',
        per_year: '642.24 EUR',
        renews: '2099-01-01',
        notice_period: '1 month',
        cancel_by: '2098-11-30',
        status: 'active',
        latest_change: 'Premium rises',
        topic: { name: 'Car insurance VW Golf', url: `${base}/topics/Car%20insurance%20VW%20Golf` },
        documents: [{ title: insuranceMeta.title, date: '2025-11-02', url: `${base}/?doc=${insurance.id}` }],
      },
    ]);
    expect(listed.note).toMatch(/haven’t been looked at yet/);
  });

  it('lists companies, topics, categories and deadlines with links to their pages', async () => {
    const { insurance } = await fileDocuments();

    const companies = await companiesTool({});
    expect(companies.companies?.map(c => c.name)).toEqual(['Notar Dr. Mustermann', 'Allianz Versicherungs-AG', 'Stadtwerke Musterstadt']);
    expect(companies.companies?.[0]).toMatchObject({ url: `${base}/companies/Notar%20Dr%252E%20Mustermann`, documents: 1, topics: ['Example UG formation'] });

    const topics = await topicsTool({ company: 'allianz' });
    expect(topics.topics).toEqual([
      {
        name: 'Car insurance VW Golf',
        url: `${base}/topics/Car%20insurance%20VW%20Golf`,
        documents: 1,
        first: '2025-11-02',
        last: '2025-11-02',
        companies: ['Allianz Versicherungs-AG'],
        latest_update: '2025-11-02: Premium for 2026 rises to 642.18 EUR',
      },
    ]);

    const categories = await categoriesTool();
    expect(categories.categories.find(c => c.name === 'Insurance')).toMatchObject({ documents: 1 });

    const deadlines = await deadlinesTool({ from: '2025-11-01' });
    expect(deadlines).toMatchObject({ from: '2025-11-01', to: '2026-01-30' });
    // The electricity bill's deadline (April) is overdue and still open
    expect(deadlines.deadlines?.map(d => [d.date, d.overdue ?? false])).toEqual([
      ['2025-04-25', true],
      ['2025-12-01', true],
    ]);
    expect(deadlines.deadlines?.[1].document).toMatchObject({ id: insurance.id, url: `${base}/?doc=${insurance.id}` });
    expect((await deadlinesTool({ from: '2025-11-01', overdue: false })).deadlines?.map(d => d.date)).toEqual(['2025-12-01']);
    expect(today(new Date('2026-10-16T23:30:00Z'))).toBe('2026-10-17');
  });
});

describe('the app and its public edge changing the same list at once', () => {
  // Two instances of a list over one store, as the app and the edge each have one
  interface Item {
    id: string;
    lastUsedAt: string | null;
    refresh: string[];
  }
  const grant = (id: string): Item => ({ id, lastUsedAt: null, refresh: ['r1'] });
  const twoInstances = () => [new Shelf<Item>('mcp-grants', 'grants'), new Shelf<Item>('mcp-grants', 'grants')] as const;
  const touch = (at: string) => (list: Item[]) => {
    const found = list.find(g => g.id === 'g1');
    if (found) found.lastUsedAt = at;
  };

  it('keeps a disconnected app disconnected when the edge notes its use at the same moment', async () => {
    await getStore().set('mcp-grants', { grants: [grant('g1')] });
    const [app, edge] = twoInstances();
    await Promise.all([
      app.change(list => {
        const at = list.findIndex(g => g.id === 'g1');
        if (at >= 0) list.splice(at, 1);
      }),
      edge.change(touch(new Date().toISOString())),
    ]);
    expect(await app.read(true)).toEqual([]);
    expect(await edge.read(true)).toEqual([]);
  });

  it('keeps an app just allowed when the edge notes another app’s use at the same moment', async () => {
    await getStore().set('mcp-grants', { grants: [grant('g1')] });
    const [app, edge] = twoInstances();
    const at = new Date().toISOString();
    await Promise.all([app.change(list => void list.push(grant('g2'))), edge.change(touch(at))]);
    expect(await app.read(true)).toEqual([{ ...grant('g1'), lastUsedAt: at }, grant('g2')]);
  });

  it('keeps a new refresh token when the other instance notes the app’s use at the same moment', async () => {
    await getStore().set('mcp-grants', { grants: [grant('g1')] });
    const [one, other] = twoInstances();
    const at = new Date().toISOString();
    await Promise.all([
      one.change(list => {
        list[0].refresh = ['r2', ...list[0].refresh];
      }),
      other.change(touch(at)),
    ]);
    expect(await one.read(true)).toEqual([{ id: 'g1', lastUsedAt: at, refresh: ['r2', 'r1'] }]);
  });

  it('keeps what both noted at the same moment', async () => {
    const app = new Shelf<{ what: string }>('mcp-events', 'events');
    const edge = new Shelf<{ what: string }>('mcp-events', 'events');
    await Promise.all([app.change(list => void list.unshift({ what: 'Allowed' })), edge.change(list => void list.unshift({ what: 'Connected' }))]);
    expect((await app.read(true)).map(e => e.what).sort()).toEqual(['Allowed', 'Connected']);
  });
});

// ---------- Only the apps allowed, only while the owner is connecting one ----------

describe('the apps allowed and the window for connecting one, as shipped', () => {
  beforeEach(async () => {
    // Nothing chosen in Settings yet: Gemini alone, and no window open
    (getStore() as MemoryStore).data.delete('mcp-access');
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
  });

  // Straight to Paperwork, without opening the window first; from the address given (as Cloud Run adds it)
  async function registerAsIs(redirect: string, from?: string) {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(from ? { 'x-forwarded-for': from } : {}) },
      body: JSON.stringify({ client_name: 'Google', redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_basic' }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }
  const openWindow = () => api<AiAccess>('POST', '/mcp/registration', { open: true });

  it('lets Gemini register only while Connect an AI app is open, and never Claude', async () => {
    expect(await registerAsIs(GEMINI_CALLBACK)).toMatchObject({ status: 403, body: { error: 'access_denied', error_description: expect.stringContaining('Connect an AI app') } });

    const opened = await openWindow();
    expect(opened.body.registration).toMatchObject({ open: true, until: expect.any(String) });
    expect(opened.body.registration.secondsLeft).toBeGreaterThan(14 * 60);
    expect(opened.body.apps).toEqual([
      { id: 'gemini', name: 'Gemini', allowed: true },
      { id: 'claude', name: 'Claude', allowed: false },
      { id: 'chatgpt', name: 'ChatGPT', allowed: false },
    ]);
    // A minute later, so this refusal is noted too (at most one a minute is)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    const claude = await registerAsIs(CALLBACK);
    vi.useRealTimers();
    expect(claude).toMatchObject({ status: 400, body: { error: 'invalid_redirect_uri', error_description: expect.stringContaining('Paperwork accepts only Gemini') } });
    expect(await registerAsIs(GEMINI_CALLBACK)).toMatchObject({ status: 201, body: { client_name: 'Gemini' } });

    const events = (await api<AiAccess>('GET', '/mcp')).body.events;
    expect(events.map(e => [e.ok, e.what.split(':')[0]])).toEqual([
      [true, 'Registered itself'],
      [false, 'Registration refused'],
      [false, 'Registration refused'],
    ]);
    expect(events[2].what).toBe('Registration refused: no Connect window open');
  });

  it('closes the window after a quarter of an hour, and after fifty registrations, three from any one address', async () => {
    await openWindow();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + WINDOW_MS + 1000);
    expect((await registerAsIs(GEMINI_CALLBACK)).status).toBe(403);
    expect((await api<AiAccess>('GET', '/mcp')).body.registration).toEqual({ open: false, until: null, secondsLeft: 0 });
    vi.useRealTimers();

    await openWindow();
    // A stranger using up its share, with made-up Gemini addresses, leaves the window to everyone else
    const fromOne: number[] = [];
    for (let i = 0; i < 4; i++) fromOne.push((await registerAsIs(`${GEMINI_CALLBACK}-${i}`, '198.51.100.7')).status);
    expect(fromOne).toEqual([201, 201, 201, 403]);
    const refused = await registerAsIs(GEMINI_CALLBACK, '198.51.100.7');
    expect(refused.body.error_description).toContain('or add the app by hand');
    expect((await registerAsIs(GEMINI_CALLBACK, '203.0.113.5')).status).toBe(201);

    const statuses: number[] = [];
    for (let i = 0; i < 47; i++) statuses.push((await registerAsIs(GEMINI_CALLBACK, `192.0.2.${i}`)).status);
    expect(statuses).toEqual([...Array(46).fill(201), 403]);

    // And when the owner closes it
    await openWindow();
    expect((await api<AiAccess>('POST', '/mcp/registration', { open: false })).body.registration.open).toBe(false);
    expect((await registerAsIs(GEMINI_CALLBACK)).status).toBe(403);
    expect((await api('POST', '/mcp/registration', { open: 'yes' })).status).toBe(400);
  });

  it('closes the window once Gemini is allowed in', async () => {
    await openWindow();
    const registered = (await registerAsIs(GEMINI_CALLBACK)).body;
    const { tokens } = await connectWith(registered.client_id, GEMINI_CALLBACK, basic(registered.client_id, registered.client_secret));
    expect(tokens.status).toBe(200);
    expect((await rpc(tokens.body.access_token, 'tools/list', {})).status).toBe(200);

    const { body } = await api<AiAccess>('GET', '/mcp');
    expect(body.registration.open).toBe(false);
    expect(body.connections).toEqual([expect.objectContaining({ name: 'Gemini', app: 'gemini', allowed: true })]);
    expect((await registerAsIs(GEMINI_CALLBACK)).status).toBe(403);
  });

  it('allows an app that registered itself in only while the window is open, and forgets the others registered then', async () => {
    await openWindow();
    // A stranger, polling until the owner opens the window, registers its own Gemini connector
    const STRANGER = GEMINI_CALLBACK.replace('abc123', '999999999999999999999');
    const stranger = (await registerAsIs(STRANGER, '198.51.100.7')).body;
    // Registered, but never allowed in: within the window it could be
    const strangerUrl = () => authorizeUrl({ response_type: 'code', client_id: stranger.client_id, redirect_uri: STRANGER, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const shown = await fetch(strangerUrl(), { headers: { cookie } });
    expect(shown.status).toBe(200);
    const strangerTicket = /name="ticket" value="([^"]+)"/.exec(await shown.text())![1];

    // The owner connects their own Gemini, which closes the window
    const own = (await registerAsIs(GEMINI_CALLBACK, '203.0.113.5')).body;
    expect((await connectWith(own.client_id, GEMINI_CALLBACK, basic(own.client_id, own.client_secret))).tokens.status).toBe(200);

    // Later, a link to the stranger's request leads nowhere, and the page shown before can't be answered
    const later = await fetch(strangerUrl(), { headers: { cookie }, redirect: 'manual' });
    expect(later.status).toBe(400);
    expect(later.headers.get('location')).toBeNull();
    const answered = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket: strangerTicket, decision: 'allow' }),
      redirect: 'manual',
    });
    expect(answered.status).toBe(400);
    expect(answered.headers.get('location')).toBeNull();
    expect((await connections()).map(c => c.name)).toEqual(['Gemini']);

    // Nor through a later window: the registration is forgotten, the owner's own one kept
    const clients = (await getStore().get<{ clients: { id: string }[] }>('mcp-clients'))!.clients.map(c => c.id);
    expect(clients).toEqual([own.client_id]);
    await openWindow();
    expect(await (await fetch(strangerUrl(), { headers: { cookie } })).text()).toContain('isn’t registered with this Paperwork');
  });

  it('allows an app that registered itself in only with the window open, and one added by hand any time', async () => {
    await openWindow();
    const registered = (await registerAsIs(GEMINI_CALLBACK)).body;
    await api('POST', '/mcp/registration', { open: false });
    const url = () => authorizeUrl({ response_type: 'code', client_id: registered.client_id, redirect_uri: GEMINI_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const closed = await fetch(url(), { headers: { cookie }, redirect: 'manual' });
    expect(closed.status).toBe(400);
    expect(await closed.text()).toContain('Connect an AI app first');

    // Closed while the page was shown
    await openWindow();
    const page = await fetch(url(), { headers: { cookie } });
    const ticket = /name="ticket" value="([^"]+)"/.exec(await page.text())![1];
    await api('POST', '/mcp/registration', { open: false });
    const answered = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket, decision: 'allow' }),
      redirect: 'manual',
    });
    expect(answered.status).toBe(400);
    expect(await connections()).toEqual([]);

    // Added by hand, with no window open
    const { client, secret } = (await api<NewAiClient>('POST', '/mcp/clients', { redirectUri: GEMINI_CALLBACK })).body;
    expect((await api<AiAccess>('GET', '/mcp')).body.registration.open).toBe(false);
    expect((await connectWith(client.id, GEMINI_CALLBACK, basic(client.id, secret))).tokens.status).toBe(200);
  });

  it('notes refused registrations of any kind at most once a minute', async () => {
    for (let i = 0; i < 5; i++) expect((await registerAsIs(`https://x${i}.example/cb`, `192.0.2.${i}`)).status).toBe(400);
    const events = (await api<AiAccess>('GET', '/mcp')).body.events;
    expect(events.filter(e => e.what.startsWith('Registration refused'))).toHaveLength(1);
  });

  it('counts a registration refused for want of a window once, and notes such refusals once a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await registerAsIs(GEMINI_CALLBACK, '198.51.100.7')).status);
    expect(statuses).toEqual([...Array(30).fill(403), 429]);
    // From ever new addresses, as from an IPv6 network
    for (let i = 0; i < 45; i++) expect((await registerAsIs(GEMINI_CALLBACK, `2001:db8:${i}::1`)).status).toBe(403);
    const refusals = () => api<AiAccess>('GET', '/mcp').then(r => r.body.events.filter(e => e.what === 'Registration refused: no Connect window open').length);
    expect(await refusals()).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    await registerAsIs(GEMINI_CALLBACK, '203.0.113.5');
    vi.useRealTimers();
    expect(await refusals()).toBe(2);
  });

  it('stops an app switched off in Settings at once, and lets it work again when switched on', async () => {
    // Claude, connected while it was allowed
    await api('PUT', '/mcp/apps', { apps: ['gemini', 'claude'] });
    const { client, tokens } = await connectApp();
    expect((await rpc(tokens.access_token, 'tools/list', {})).status).toBe(200);

    const off = await api<AiAccess>('PUT', '/mcp/apps', { apps: ['gemini'] });
    expect(off.body.apps.find(a => a.id === 'claude')).toMatchObject({ allowed: false });
    expect(off.body.connections).toEqual([expect.objectContaining({ name: 'Claude', app: 'claude', allowed: false })]);
    expect(off.body.events[0]).toMatchObject({ app: 'Paperwork', ok: true, what: 'Allowed apps changed by me@example.com: Gemini' });
    expect((await rpc(tokens.access_token, 'tools/list', {})).status).toBe(401);
    const refused = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refused).toMatchObject({ status: 400, body: { error: 'unauthorized_client', error_description: expect.stringContaining('doesn’t accept Claude') } });
    // Nor can it be allowed again meanwhile
    const page = await fetch(authorizeUrl({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256' }), { headers: { cookie }, redirect: 'manual' });
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('Claude may not connect to Paperwork at the moment');

    await api('PUT', '/mcp/apps', { apps: ['gemini', 'claude'] });
    expect((await rpc(tokens.access_token, 'tools/list', {})).status).toBe(200);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).status).toBe(200);

    expect((await api<{ error: string }>('PUT', '/mcp/apps', { apps: ['gemini', 'cursor'] })).status).toBe(400);

    // Switched off, an app can still end its access
    await api('PUT', '/mcp/apps', { apps: ['gemini'] });
    const revoked = await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.access_token }) });
    expect(revoked.status).toBe(200);
    expect(await connections()).toEqual([]);
  });

  it('refuses the page allowing an app that was switched off after the page was shown', async () => {
    await api('PUT', '/mcp/apps', { apps: ['gemini', 'claude'] });
    const client = (await register({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' })).body;
    const page = await fetch(authorizeUrl({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256' }), { headers: { cookie } });
    const ticket = /name="ticket" value="([^"]+)"/.exec(await page.text())![1];
    await api('PUT', '/mcp/apps', { apps: ['gemini'] });
    const answered = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket, decision: 'allow' }),
      redirect: 'manual',
    });
    expect(answered.status).toBe(400);
    expect(answered.headers.get('location')).toBeNull();
    expect(await connections()).toEqual([]);
  });

  it('adds only apps allowed by hand', async () => {
    const refused = await api<{ error: string }>('POST', '/mcp/clients', { redirectUri: CALLBACK });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringContaining('Paperwork accepts only Gemini') } });
    // Gemini by hand needs no window
    const added = await api<NewAiClient>('POST', '/mcp/clients', { redirectUri: GEMINI_CALLBACK });
    expect(added.status).toBe(200);
    expect(added.body.client).toMatchObject({ name: 'Gemini', app: 'gemini', allowed: true });
    expect((await api<AiAccess>('PUT', '/mcp/apps', { apps: [] })).body.clients).toEqual([expect.objectContaining({ id: added.body.client.id, allowed: false })]);
  });

  it('gives an app connected through a registration from before apps were told apart no access', async () => {
    // A grant as stored before grants named their app, for an app registered before registrations were stored: only
    // the client ID's hash is known, so it is no app Paperwork can allow
    await api('PUT', '/mcp/apps', { apps: ['gemini', 'claude', 'chatgpt'] });
    const { tokens } = await connectApp();
    const stored = (await getStore().get<{ grants: Record<string, unknown>[] }>('mcp-grants'))!;
    await getStore().set('mcp-grants', { grants: stored.grants.map(({ app: _app, ...g }) => ({ ...g, client: crypto.createHash('sha256').update('pwc.legacy').digest('hex') })) });
    forgetGrants();
    expect((await rpc(tokens.access_token, 'tools/list', {})).status).toBe(401);
  });
});

// ---------- On the public edge ----------

describe('the MCP server on the public edge', () => {
  afterEach(() => {
    delete process.env.PAPERWORK_ROLE;
  });

  it('says the index is being built rather than building it', async () => {
    // A document in Drive, but nothing in the index yet
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    const bills = h.fake.childrenOf(h.fake.find('Paperwork')!.id).find(f => f.name === 'Bills & Receipts')!;
    const name = fileName(billMeta, { name: 'scan.pdf', mimeType: 'application/pdf' });
    h.fake.add({ name, parents: [bills.id], ...docLabels(billMeta, name), content: await textPdf(['Stadtwerke Musterstadt']) });
    const { tokens } = await connectApp();

    process.env.PAPERWORK_ROLE = 'edge';
    h.reconciled = 0;
    const called = await rpc(tokens.access_token, 'tools/call', { name: 'search', arguments: { query: '' } });
    expect(called.body.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Paperwork’s index is being built; open Paperwork once and try again.' }] });
    expect(h.reconciled).toBe(0);
    expect(await getIndex().all()).toEqual([]);

    // The app fills it, as when the owner opens Paperwork
    delete process.env.PAPERWORK_ROLE;
    await searchTool({ query: '' });
    expect(h.reconciled).toBe(1);
    process.env.PAPERWORK_ROLE = 'edge';
    const found = await rpc(tokens.access_token, 'tools/call', { name: 'search', arguments: { query: '' } });
    expect(JSON.parse(found.body.result.content[0].text)).toMatchObject({ total: 1 });
  });
});
