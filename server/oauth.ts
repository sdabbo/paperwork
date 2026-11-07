// How AI apps (Gemini, Claude, ChatGPT) get to search the documents through the MCP server (mcp.ts): OAuth 2.1, as
// the MCP specification asks for (modelcontextprotocol.io/specification, "Authorization").
//
// - An app learns where to ask from /.well-known/oauth-protected-resource/mcp and
//   /.well-known/oauth-authorization-server, and registers itself at /oauth/register.
// - /oauth/authorize: the owner signs in with Google as for the app itself (an account in ALLOWED_EMAILS) and is
//   shown which app asks and where the access goes. Allowing it sends a one-time code back to the app (with PKCE).
// - /oauth/token trades the code for an access token (an hour, for /mcp only) and a refresh token, and a refresh
//   token for new ones. An app unused for 90 days has to be allowed again.
// - Disconnecting the app in Settings, or /oauth/revoke, ends its access at once.
//
// Only the apps the owner allowed in Settings (aiApps.ts; Gemini unless changed) may register, connect and use the
// access; an app switched off there loses access at once and gets it back when switched on again. An app may
// register itself, and an app that registered itself may be allowed in, only while the owner has "Connect an AI
// app" open in Settings (a quarter of an hour); allowing one closes it and forgets the others that registered then.
//
// When Paperwork runs as two services (roles.ts), apps talk to the public edge (PUBLIC_URL): metadata, registration,
// tokens and /mcp. The page asking the owner is served by the app behind Google's Identity-Aware Proxy: the edge
// sends /oauth/authorize on to it. The lists both services change are changed in store transactions (Shelf).
//
// An app registers itself (or the owner adds it by hand in Settings, for apps that ask for a client ID and secret
// instead) and gets a short client ID. Registrations never allowed in are forgotten after a week, and an address
// may register only so often, so registering costs little. What is stored per connected app (a grant) are hashes
// of its code and refresh tokens, never the tokens; of an app's secret, too, only the hash is kept. What happened
// when apps tried to connect is noted for Settings, so one that didn't can be understood.
import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { AiAppId, AiClient, AiConnection, AiEvent } from '../shared/types.js';
import {
  StoredAccess,
  WINDOW_MS,
  appNames,
  appOf,
  appOfUris,
  closeRegistration,
  isAllowedApp,
  openRegistration,
  readAccess,
  setApps,
  takeRegistrationSlot,
  windowOpen,
} from './aiApps.js';
import { currentUser, isAllowed } from './auth.js';
import { config } from './config.js';
import { deriveKey, sameSecret, sha256 } from './crypto.js';
import { getStore } from './store.js';

// The one thing an app may do: search and read the documents
export const SCOPE = 'documents:read';

const ACCESS_SECONDS = 60 * 60;
const CODE_MS = 5 * 60 * 1000;
// An app that hasn't used its access for this long has to be allowed again
const UNUSED_MS = 90 * 24 * 60 * 60 * 1000;
// Refresh tokens accepted per app: the newest and the two before it, so an app that refreshed twice at once, or
// lost an answer on the way, keeps working
const REFRESH_KEPT = 3;
// How often "last used" is written
const TOUCH_MS = 15 * 60 * 1000;
// How long a copy of a list is used (only where a moment's delay does no harm: finding a registered app)
const CACHE_MS = 30 * 1000;
// Apps that registered themselves but were never allowed in are forgotten after this long (they register again),
// and at most this many are kept
const UNUSED_CLIENT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UNUSED_CLIENTS = 200;
// Registrations, and notes in the list of connection attempts, per caller address and hour
const NOTES_PER_HOUR = 30;
const MAX_EVENTS = 40;
// Refused registrations come from anyone on the internet: they are noted for Settings at most once a minute, whoever
// asks (all of them go to the log), so strangers can't push what happened out of the list
const REFUSAL_NOTE_MS = 60 * 1000;

// All on the address apps use (the edge's, when Paperwork runs as two services; the app's otherwise)
export const issuer = () => config.publicUrl;
export const mcpUrl = () => `${config.publicUrl}/mcp`;
export const resourceMetadataUrl = () => `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

// The MCP server's address as an app names it (RFC 8707); the bare address of Paperwork is taken to mean it too
const sameResource = (value: string) => [mcpUrl(), issuer()].includes(value.replace(/\/+$/, ''));

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    // The app it is about, when known
    readonly client: { name: string } | null = null
  ) {
    super(message);
  }
}

const sendError = (res: Response, err: OAuthError) => res.status(err.status).json({ error: err.code, error_description: err.message });

const random = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');
const mac = (purpose: string, text: string) => crypto.createHmac('sha256', deriveKey('mcp')).update(`${purpose}:${text}`).digest('base64url');

// A list kept in the store, read through a short-lived copy (or fresh) and changed one change at a time: in this
// process through a queue, and against the other service through a store transaction, so a change made there at
// the same moment is never lost or undone. Written only when something changed. Exported for tests.
export class Shelf<T> {
  private copy: { items: T[]; at: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private key: string,
    private field: string,
    // Items no longer worth keeping are dropped whenever the list changes
    private keep: (item: T, now: number) => boolean = () => true
  ) {}

  async read(fresh = false): Promise<T[]> {
    if (!fresh && this.copy && Date.now() - this.copy.at < CACHE_MS) return this.copy.items;
    const stored = await getStore().get<Record<string, T[]>>(this.key);
    this.copy = { items: stored?.[this.field] ?? [], at: Date.now() };
    return this.copy.items;
  }

  // `fn` changes the list it is given and may run more than once (a transaction tried again), so it only
  // computes: times, IDs and codes are made before calling change()
  change<R>(fn: (items: T[]) => R): Promise<R> {
    const run = this.queue.then(async () => {
      const now = Date.now();
      const out = await getStore().update<Record<string, T[]>, { result: R; items: T[] }>(this.key, stored => {
        const before = stored?.[this.field] ?? [];
        const items = structuredClone(before).filter(item => this.keep(item, now));
        const result = fn(items);
        return { next: JSON.stringify(items) !== JSON.stringify(before) ? { [this.field]: items } : undefined, result: { result, items } };
      });
      this.copy = { items: out.items, at: Date.now() };
      return out.result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // Once the changes under way are written
  settled(): Promise<unknown> {
    return this.queue;
  }

  forget() {
    this.copy = null;
  }
}

// ---------- What happened, for Settings ----------

const events = new Shelf<AiEvent>('mcp-events', 'events');
const noted = new Map<string, number[]>();
let refusalNotedAt = 0;

// The caller's address: Cloud Run's front end adds it last to X-Forwarded-For (what comes before, the caller wrote)
const callerAddress = (req: Request) => (req.get('x-forwarded-for') ?? '').split(',').pop()?.trim() || req.socket.remoteAddress || '';

// Whether this address may register, or add to the list of connection attempts, once more this hour
function withinLimit(address: string, now = Date.now()): boolean {
  const recent = (noted.get(address) ?? []).filter(t => now - t < 60 * 60 * 1000);
  const ok = recent.length < NOTES_PER_HOUR;
  if (ok) recent.push(now);
  if (noted.size > 5000) noted.clear();
  noted.set(address, recent);
  return ok;
}

// Notes what happened when an app tried to connect: in the log, and (unless `req`'s address has noted too much
// this hour) in the list Settings shows
function note(req: Request | null, app: string, ok: boolean, what: string) {
  (ok ? console.log : console.warn)(`AI app ${app}: ${what}`);
  if (req && !withinLimit(callerAddress(req))) return;
  const at = new Date().toISOString();
  events
    .change(list => {
      list.unshift({ at, app, ok, what });
      list.splice(MAX_EVENTS);
    })
    .catch(err => console.warn('Noting an AI app’s connection attempt failed:', (err as Error)?.message));
}

function noteRefusal(app: string, what: string) {
  const now = Date.now();
  if (now - refusalNotedAt >= REFUSAL_NOTE_MS) {
    refusalNotedAt = now;
    note(null, app, false, what);
  } else console.warn(`AI app ${app}: ${what}`);
}

// Newest first, including what was noted a moment ago
export async function recentEvents(): Promise<AiEvent[]> {
  await events.settled();
  return events.read(true);
}

// ---------- Registration ----------

type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
const AUTH_METHODS: AuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  method: AuthMethod;
  // Hash of its secret; null for an app without one
  secretHash: string | null;
  // Added by the owner in Settings, rather than registered by the app itself
  manual: boolean;
  createdAt: string;
}

const CLIENT_ID = /^pwc_[A-Za-z0-9_-]{22}$/;
const clients = new Shelf<Client>('mcp-clients', 'clients');

// Apps registered before registrations were stored had IDs that carried the registration, signed (pwc.<data>.<mac>);
// those still work
function legacyClient(id: string): Client | null {
  const [prefix, body, signature, ...rest] = id.split('.');
  if (prefix !== 'pwc' || !body || !signature || rest.length || !sameSecret(signature, mac('client', body).slice(0, 22))) return null;
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return { id, name: String(raw.n), redirectUris: raw.r, method: raw.m, secretHash: null, manual: false, createdAt: new Date(raw.t * 1000).toISOString() };
  } catch {
    return null;
  }
}

export async function findClient(id: unknown): Promise<Client | null> {
  if (typeof id !== 'string' || id.length > 4000) return null;
  if (id.startsWith('pwc.')) return legacyClient(id);
  if (!CLIENT_ID.test(id)) return null;
  const find = (list: Client[]) => list.find(c => c.id === id) ?? null;
  // One registered through another instance a moment ago isn't in this one's copy yet
  return find(await clients.read()) ?? find(await clients.read(true));
}

function rightSecret(client: Client, secret: unknown): boolean {
  if (typeof secret !== 'string' || !secret) return false;
  if (client.id.startsWith('pwc.')) return sameSecret(secret, mac('secret', client.id));
  return !!client.secretHash && sameSecret(sha256(secret), client.secretHash);
}

// Grants name their app by its ID; those of legacy apps by the ID's hash
const grantOf = (grant: { client: string }, client: Client) => grant.client === client.id || grant.client === sha256(client.id);

// Keeps a new app (if given), forgetting registrations nobody allowed in for a week (and the oldest of them beyond
// the limit), and those made since `dropUnusedSince` (the window an app was just allowed in through)
async function keepClient(client: Client | null, dropUnusedSince = Infinity) {
  const used = new Set((await grants.read(true)).map(g => g.client));
  const now = Date.now();
  await clients.change(list => {
    // Not twice when tried again
    const added = client && !list.some(c => c.id === client.id) ? [client] : [];
    const unused = (c: Client) => !c.manual && !used.has(c.id);
    const stale = (c: Client) => now - Date.parse(c.createdAt) >= UNUSED_CLIENT_MS || Date.parse(c.createdAt) >= dropUnusedSince;
    const kept = list.filter(c => !unused(c) || !stale(c));
    const spare = kept.filter(unused);
    const dropped = new Set(spare.slice(0, Math.max(0, spare.length + added.length - MAX_UNUSED_CLIENTS)).map(c => c.id));
    list.splice(0, list.length, ...kept.filter(c => !dropped.has(c.id)), ...added);
  });
}

const newClientId = () => `pwc_${random(16)}`;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const NOT_REDIRECTS = new Set(['javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:', 'ws:', 'wss:', 'ftp:', 'mailto:']);

// Why an app can't be sent to this address, or null. Web addresses must be https (http only on this computer, for
// apps running there); an app's own scheme (cursor://…) is fine.
export function redirectProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `${uri} is not an address.`;
  }
  if (uri.includes('#')) return 'A redirect address can’t have a fragment (#).';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) ? null : 'Plain http is only allowed on this computer (localhost); use https.';
  if (NOT_REDIRECTS.has(url.protocol) || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return `${url.protocol} addresses can’t be used.`;
  return null;
}

// Exactly a registered address; on this computer, on any port (an app there listens wherever it can, RFC 8252)
export function matchesRedirect(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return false;
  return registered.some(r => {
    try {
      const candidate = new URL(r);
      if (candidate.protocol !== 'http:' || !LOOPBACK.has(candidate.hostname)) return false;
      candidate.port = url.port;
      return candidate.href === url.href;
    } catch {
      return false;
    }
  });
}

// Where the access goes, as the owner is shown it: what the app really is, whatever name it gave itself
export function destination(uri: string): string {
  const url = new URL(uri);
  if (url.protocol === 'https:') return url.host;
  if (url.protocol === 'http:') return `this computer (${url.host})`;
  return `an app on this device (${url.protocol}//)`;
}

// Apps known by where their answers go (aiApps.ts). That name is shown rather than the one an app gives itself: it
// says which app really gets the access (Gemini registers as "Google").
export function knownApp(uri: string): string | null {
  return appOf(uri)?.name ?? null;
}

function appName(given: unknown, uris: string[]): string {
  const known = uris.map(knownApp);
  if (known[0] && known.every(k => k === known[0])) return known[0];
  const named = typeof given === 'string' ? given.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) : '';
  return named || destination(uris[0]);
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

// What an app asked for when registering, for the list of connection attempts
function described(body: Record<string, unknown>): string {
  const parts = [
    `redirect_uris ${JSON.stringify(body.redirect_uris ?? null)}`,
    `token_endpoint_auth_method ${JSON.stringify(body.token_endpoint_auth_method ?? null)}`,
    body.grant_types !== undefined ? `grant_types ${JSON.stringify(body.grant_types)}` : null,
    body.response_types !== undefined ? `response_types ${JSON.stringify(body.response_types)}` : null,
    body.scope !== undefined ? `scope ${JSON.stringify(body.scope)}` : null,
    `other fields: ${Object.keys(body).filter(k => !['redirect_uris', 'token_endpoint_auth_method', 'grant_types', 'response_types', 'scope', 'client_name'].includes(k)).join(', ') || 'none'}`,
  ];
  return parts.filter(Boolean).join('; ').slice(0, 900);
}

// RFC 7591. Anything Paperwork doesn't offer (other grant types, response types, scopes, ways to authenticate) is
// answered with what it does offer, rather than refused: apps cope with that better than with a refusal, after
// which some (Gemini) only ask for a client ID and secret. Refused are addresses an app can't safely be sent to,
// apps not allowed in Settings, and any registration outside the "Connect an AI app" window.
async function register(req: Request, res: Response) {
  const refuse = (code: string, message: string, body: Record<string, unknown> = {}) => {
    const named = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'An app';
    noteRefusal(named, `Registration refused: ${message} It asked for: ${described(body)}`);
    res.status(400).json({ error: code, error_description: message });
  };
  if (!withinLimit(callerAddress(req))) {
    console.warn('AI app registration refused: too many from', callerAddress(req));
    return res.status(429).json({ error: 'temporarily_unavailable', error_description: 'Too many registrations from this address. Try again in an hour.' });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(typeof req.body === 'string' && req.body.trim() ? req.body : '{}');
  } catch {
    return refuse('invalid_client_metadata', 'The registration isn’t JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid_client_metadata', 'The registration isn’t a JSON object.');

  const given = typeof body.redirect_uris === 'string' ? [body.redirect_uris] : body.redirect_uris;
  if (!Array.isArray(given) || !given.length || given.length > 10 || !given.every(u => typeof u === 'string' && u.length <= 2000)) {
    return refuse('invalid_redirect_uri', 'Give one to ten redirect_uris.', body);
  }
  const uris = given as string[];
  for (const uri of uris) {
    const problem = redirectProblem(uri);
    if (problem) return refuse('invalid_redirect_uri', problem, body);
  }
  // Which app it is, by where its answers go; checked before the window, so a refusal writes nothing there
  const access = await readAccess();
  if (!isAllowedApp(access, appOfUris(uris))) {
    return refuse('invalid_redirect_uri', `Paperwork accepts only ${appNames(access.apps)} at the moment (Settings › AI assistants); this app’s answers go to ${uris.map(destination).join(', ')}.`, body);
  }
  if (!(await takeRegistrationSlot(callerAddress(req)))) {
    // The caller was counted above already
    noteRefusal(appName(body.client_name, uris), 'Registration refused: no Connect window open');
    return res.status(403).json({
      error: 'access_denied',
      error_description: 'Registration is closed. In Paperwork: Settings › AI assistants › Connect an AI app, then try again within 15 minutes, or add the app by hand there.',
    });
  }
  const asked = body.token_endpoint_auth_method;
  // RFC 7591: an app that doesn't say how it authenticates gets a secret
  const method: AuthMethod = asked === undefined ? 'client_secret_basic' : AUTH_METHODS.includes(asked as AuthMethod) ? (asked as AuthMethod) : 'client_secret_basic';
  const secret = method === 'none' ? null : random(32);
  const client: Client = {
    id: newClientId(),
    name: appName(body.client_name, uris),
    redirectUris: uris,
    method,
    secretHash: secret && sha256(secret),
    manual: false,
    createdAt: new Date().toISOString(),
  };
  await keepClient(client);
  const replaced = asked !== undefined && asked !== method ? ` (it asked for ${JSON.stringify(asked)}, which Paperwork doesn’t offer)` : '';
  note(null, client.name, true, `Registered itself: answers go to ${uris.map(destination).join(', ')}; signs in with ${method}${replaced}. It asked for: ${described(body)}`);
  res
    .status(201)
    .setHeader('Cache-Control', 'no-store')
    .json({
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: client.name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    });
}

// ---------- Apps added by hand (Settings) ----------

export class ClientProblem extends Error {}

function toAiClient(c: Client, access: StoredAccess): AiClient {
  const app = appOfUris(c.redirectUris);
  return { id: c.id, name: c.name, redirectUri: c.redirectUris[0], host: destination(c.redirectUris[0]), createdAt: c.createdAt, app, allowed: isAllowedApp(access, app) };
}

export async function manualClients(): Promise<AiClient[]> {
  const [list, access] = await Promise.all([clients.read(true), readAccess()]);
  return list
    .filter(c => c.manual)
    .map(c => toAiClient(c, access))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// For an app that asks for a client ID and secret: both, for the app's redirect address. The secret is shown once.
export async function addClient(input: { redirectUri: unknown; name?: unknown }, email: string): Promise<{ client: AiClient; secret: string }> {
  const uri = typeof input.redirectUri === 'string' ? input.redirectUri.trim() : '';
  if (!uri) throw new ClientProblem('Paste the app’s redirect URI.');
  if (uri.length > 2000) throw new ClientProblem('That redirect URI is too long.');
  const problem = redirectProblem(uri);
  if (problem) throw new ClientProblem(problem);
  const access = await readAccess();
  if (!isAllowedApp(access, appOfUris([uri]))) throw new ClientProblem(`Paperwork accepts only ${appNames(access.apps)} at the moment; turn the app on above first.`);
  const secret = random(32);
  const client: Client = {
    id: newClientId(),
    name: appName(input.name, [uri]),
    redirectUris: [uri],
    method: 'client_secret_basic',
    secretHash: sha256(secret),
    manual: true,
    createdAt: new Date().toISOString(),
  };
  await keepClient(client);
  note(null, client.name, true, `Added by hand by ${email}: answers go to ${destination(uri)}`);
  return { client: toAiClient(client, access), secret };
}

// Removes an app added by hand, and disconnects whatever connected through it
export async function removeClient(id: string): Promise<void> {
  await clients.change(list => {
    const at = list.findIndex(c => c.id === id && c.manual);
    if (at >= 0) list.splice(at, 1);
  });
  await grants.change(list => {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].client === id) list.splice(i, 1);
  });
}

// The app calling the token or revocation endpoint: its ID, and its secret when it registered with one
async function authenticate(req: Request): Promise<Client> {
  let id: unknown = req.body?.client_id;
  let secret: unknown = req.body?.client_secret;
  const header = req.get('authorization');
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    try {
      if (at < 0) throw new Error('No colon');
      id = decodeURIComponent(decoded.slice(0, at));
      secret = decodeURIComponent(decoded.slice(at + 1));
    } catch {
      throw new OAuthError('invalid_client', 'Malformed Basic authorization.', 401);
    }
  }
  const client = await findClient(id);
  if (!client) throw new OAuthError('invalid_client', 'This app isn’t registered with Paperwork. Register it again.', 401);
  if (client.method !== 'none' && !rightSecret(client, secret)) throw new OAuthError('invalid_client', 'The client secret is wrong or missing.', 401, client);
  return client;
}

// ---------- Grants: the apps allowed in ----------

interface Grant {
  id: string;
  // The app's client ID (the ID's hash, for apps registered before registrations were stored)
  client: string;
  // Which app it is (aiApps.ts); missing in grants made before apps were told apart, then found by the client
  app?: AiAppId | null;
  name: string;
  host: string;
  email: string;
  createdAt: string;
  lastUsedAt: string | null;
  // Until the app trades it for tokens, a few minutes at most
  code: { hash: string; expiresAt: number; redirectUri: string; challenge: string } | null;
  // Hashes of the refresh tokens still accepted, newest first; none until the code is traded
  refresh: string[];
}

function alive(grant: Grant, now: number): boolean {
  if (!grant.refresh.length) return !!grant.code && grant.code.expiresAt > now;
  return now - Date.parse(grant.lastUsedAt ?? grant.createdAt) < UNUSED_MS;
}

const grants = new Shelf<Grant>('mcp-grants', 'grants', alive);

// The app a grant is for. Grants of apps registered before registrations were stored name only the client ID's
// hash, so they are of no known app.
async function appOfGrant(grant: Grant): Promise<AiAppId | null> {
  if (grant.app !== undefined) return grant.app;
  return appOfUris((await findClient(grant.client))?.redirectUris ?? []);
}

export async function connections(): Promise<AiConnection[]> {
  const now = Date.now();
  const [list, access] = await Promise.all([grants.read(true), readAccess()]);
  const connected = await Promise.all(
    list
      .filter(g => g.refresh.length && alive(g, now))
      .map(async (g): Promise<AiConnection> => {
        const app = await appOfGrant(g);
        return { id: g.id, name: g.name, host: g.host, email: g.email, connectedAt: g.createdAt, lastUsedAt: g.lastUsedAt, app, allowed: isAllowedApp(access, app) };
      })
  );
  return connected.sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
}

export async function disconnect(id: string): Promise<void> {
  await grants.change(list => {
    const at = list.findIndex(g => g.id === id);
    if (at >= 0) list.splice(at, 1);
  });
}

const REFRESH_TOKEN = /^pwr\.([0-9a-f]{24})\.[A-Za-z0-9_-]{43}$/;
const CODE = /^([0-9a-f]{24})\.[A-Za-z0-9_-]{43}$/;

async function issueTokens(grant: Grant, refreshToken: string) {
  const accessToken = await new SignJWT({ gid: grant.id, scope: SCOPE })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setSubject(grant.email)
    .setIssuer(issuer())
    .setAudience(mcpUrl())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_SECONDS}s`)
    .setJti(random(12))
    .sign(deriveKey('mcp'));
  return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refreshToken, scope: SCOPE };
}

async function redeemCode(client: Client, body: Record<string, unknown>) {
  const code = typeof body.code === 'string' ? body.code : '';
  const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
  if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required.');
  const gid = CODE.exec(code)?.[1];
  if (!gid || !(await grants.read(true)).some(g => g.id === gid)) throw new OAuthError('invalid_grant', 'The code is unknown or has expired.');
  const refreshToken = `pwr.${gid}.${random(32)}`;
  const usedAt = new Date().toISOString();
  const result = await grants.change((list): Grant | OAuthError => {
    const at = list.findIndex(g => g.id === gid);
    const grant = list[at];
    if (!grant || !grantOf(grant, client)) return new OAuthError('invalid_grant', 'The code is unknown or has expired.');
    // This trade, tried again after it was written (a transaction tried again): not a code used twice
    if (!grant.code && grant.refresh[0] === sha256(refreshToken)) return grant;
    if (!grant.code) {
      // A code used twice may have been stolen: the access it gave ends (RFC 6749, 4.1.2)
      list.splice(at, 1);
      return new OAuthError('invalid_grant', 'The code was used before; the connection was ended for safety. Connect again.');
    }
    if (!sameSecret(sha256(code), grant.code.hash)) return new OAuthError('invalid_grant', 'The code is unknown or has expired.');
    if (typeof body.redirect_uri === 'string' && body.redirect_uri !== grant.code.redirectUri) return new OAuthError('invalid_grant', 'redirect_uri differs from the one the code was sent to.');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || crypto.createHash('sha256').update(verifier).digest('base64url') !== grant.code.challenge) {
      return new OAuthError('invalid_grant', 'code_verifier doesn’t match the code_challenge.');
    }
    grant.code = null;
    grant.refresh = [sha256(refreshToken)];
    grant.lastUsedAt = usedAt;
    return grant;
  });
  if (result instanceof OAuthError) throw result;
  return issueTokens(result, refreshToken);
}

async function refresh(client: Client, body: Record<string, unknown>) {
  const token = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  const gid = REFRESH_TOKEN.exec(token)?.[1];
  const hash = sha256(token);
  // Checked before changing anything, so guessing costs no writes
  if (!gid || !(await grants.read(true)).some(g => g.id === gid && g.refresh.includes(hash))) {
    throw new OAuthError('invalid_grant', 'The refresh token is unknown or has expired. Connect again.');
  }
  const next = `pwr.${gid}.${random(32)}`;
  const usedAt = new Date().toISOString();
  const result = await grants.change((list): Grant | OAuthError => {
    const grant = list.find(g => g.id === gid);
    // This refresh, tried again after it was written (a transaction tried again)
    if (grant && grant.refresh[0] === sha256(next) && grantOf(grant, client)) return grant;
    if (!grant || !grant.refresh.includes(hash) || !grantOf(grant, client)) {
      return new OAuthError('invalid_grant', 'The refresh token is unknown or has expired. Connect again.');
    }
    if (!isAllowed(grant.email)) return new OAuthError('invalid_grant', `${grant.email} may no longer use this Paperwork.`);
    grant.refresh = [sha256(next), ...grant.refresh].slice(0, REFRESH_KEPT);
    grant.lastUsedAt = usedAt;
    return grant;
  });
  if (result instanceof OAuthError) throw result;
  return issueTokens(result, next);
}

// ---------- Access to /mcp ----------

export interface Access {
  token: string;
  email: string;
  grantId: string;
  // The app's client ID
  client: string;
  app: string;
  // Seconds since 1970
  expiresAt: number;
}

const touching = new Set<string>();

function touch(grant: Grant) {
  const now = Date.now();
  const old = (iso: string | null) => !iso || now - Date.parse(iso) > TOUCH_MS;
  if (!old(grant.lastUsedAt) || touching.has(grant.id)) return;
  touching.add(grant.id);
  const at = new Date(now).toISOString();
  grants.change(list => {
    const current = list.find(g => g.id === grant.id);
    if (current && old(current.lastUsedAt)) current.lastUsedAt = at;
  })
    .catch(err => console.warn('Noting when an AI app last used Paperwork failed:', (err as Error)?.message))
    .finally(() => touching.delete(grant.id));
}

// The access an MCP request's bearer token gives, or null: signed by Paperwork for /mcp, not expired, its app
// still connected for an account that may still sign in, and still allowed in Settings. Read fresh on every
// request, so disconnecting the app or switching it off in the app ends its access on the edge at once.
// `anyApp`: also for an app switched off, so it can still revoke its access.
export async function verifyAccess(token: string, options: { anyApp?: boolean } = {}): Promise<Access | null> {
  let payload: { gid?: unknown; sub?: string; exp?: number };
  try {
    ({ payload } = await jwtVerify(token, deriveKey('mcp'), { algorithms: ['HS256'], typ: 'at+jwt', issuer: issuer(), audience: mcpUrl() }));
  } catch {
    return null;
  }
  const [list, access] = await Promise.all([grants.read(true), readAccess()]);
  const grant = list.find(g => g.id === payload.gid && g.refresh.length);
  if (!grant || grant.email !== payload.sub || !isAllowed(grant.email) || !alive(grant, Date.now())) return null;
  if (!options.anyApp && !isAllowedApp(access, await appOfGrant(grant))) return null;
  touch(grant);
  return { token, email: grant.email, grantId: grant.id, client: grant.client, app: grant.name, expiresAt: payload.exp ?? 0 };
}

// ---------- Pages: allowing an app ----------

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root{color-scheme:light;--canvas:#f6f6f4;--surface:#fff;--line:#e6e4df;--ink:#1b1a18;--ink-2:#57534e;--primary:#1b1a18;--primary-fg:#fff;--accent-soft:#e2f2ee;--accent-ink:#0a5e50;--warn-soft:#fdf1e3;--warn-ink:#8a4a03}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--canvas:#111214;--surface:#18191c;--line:#2a2c31;--ink:#ededeb;--ink-2:#b4b2ad;--primary:#ededeb;--primary-fg:#111214;--accent-soft:#12302a;--accent-ink:#8ee6d2;--warn-soft:#33240f;--warn-ink:#fcc419}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:40px 16px;background:var(--canvas);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:440px}
.head{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.head img{width:40px;height:40px}
h1{font-size:20px;line-height:1.3;margin:0;letter-spacing:-.01em}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px}
p{margin:0 0 14px;color:var(--ink-2)}
dl{margin:0 0 16px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px}
dt{color:var(--ink-2)}
dd{margin:0;overflow-wrap:anywhere}
.to{display:inline-block;background:var(--accent-soft);color:var(--accent-ink);border-radius:6px;padding:0 6px;font-weight:600}
.warn{background:var(--warn-soft);color:var(--warn-ink);border-radius:8px;padding:10px 12px;font-size:14px}
form{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
button{font:inherit;font-weight:500;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--ink)}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}
button:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px}
`;

// A page of its own (not the app): nothing on it runs scripts, and it can't be shown inside another site. Its form
// may lead back to the app it is for after the answer, and on from there: browsers check every redirect after a
// form against form-action, and an app's address may hand on to another (Google's relay for Gemini passes the
// answer on to another Google address). So any https address, or the app's own on this computer or device.
function sendPage(res: Response, status: number, title: string, body: string, backTo?: string) {
  let target = '';
  if (backTo) {
    const url = new URL(backTo);
    target = ` ${url.protocol === 'https:' ? 'https:' : url.protocol === 'http:' ? url.origin : url.protocol}`;
  }
  res.status(status);
  res.setHeader(
    'Content-Security-Policy',
    ["default-src 'none'", "style-src 'unsafe-inline'", "img-src 'self'", `form-action 'self'${target}`, "frame-ancestors 'none'", "base-uri 'none'"].join('; ')
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Paperwork</title><link rel="icon" href="/icons/icon.svg"><style>${STYLE}</style></head><body><main><div class="head"><img src="/icons/icon.svg" alt=""><h1>${escapeHtml(title)}</h1></div><div class="card">${body}</div></main></body></html>`
  );
}

const problemPage = (res: Response, message: string) => sendPage(res, 400, 'This link doesn’t work', `<p>${escapeHtml(message)}</p><p>Start connecting Paperwork again in the app.</p>`);

interface Ticket {
  // Client ID, redirect address, state, code challenge, and who was asked
  cid: string;
  ru: string;
  st?: string;
  cc: string;
  em: string;
}

// The consent page's answer carries what was asked, signed, so it can only answer that page
const signTicket = (ticket: Ticket) =>
  new SignJWT({ ...ticket, use: 'consent' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(deriveKey('mcp'));

async function readTicket(value: unknown): Promise<Ticket | null> {
  if (typeof value !== 'string') return null;
  try {
    const { payload } = await jwtVerify(value, deriveKey('mcp'), { algorithms: ['HS256'] });
    return payload.use === 'consent' && typeof payload.cid === 'string' && typeof payload.ru === 'string' ? (payload as unknown as Ticket) : null;
  } catch {
    return null;
  }
}

async function authorize(req: Request, res: Response) {
  const one = (key: string) => (typeof req.query[key] === 'string' ? (req.query[key] as string) : undefined);
  const clientId = one('client_id');
  const client = await findClient(clientId);
  // A request Paperwork can't take is answered here, not at the app's address: anyone may register an app, so
  // answering there would let any link to Paperwork lead elsewhere. The app's address is only ever visited after
  // the owner answered the page that names it.
  const refuse = (message: string) => {
    note(req, client?.name ?? 'An app', false, `Request to connect refused: ${message}`);
    problemPage(res, message);
  };
  if (!client) return refuse(`The app asking (client ID ${JSON.stringify(String(clientId ?? '').slice(0, 120))}) isn’t registered with this Paperwork.`);
  const redirectUri = one('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !matchesRedirect(client.redirectUris, redirectUri)) {
    return refuse(`The app asked to be answered at ${redirectUri ?? 'no address'}, which it didn’t register.`);
  }
  const access = await readAccess();
  if (!isAllowedApp(access, appOf(redirectUri)?.id ?? null)) {
    return refuse(`${knownApp(redirectUri) ?? client.name} may not connect to Paperwork at the moment; it accepts only ${appNames(access.apps)} (Settings › AI assistants).`);
  }
  // Anyone can register while the window is open: an app that registered itself is allowed in only while the owner
  // is connecting one, so a registration left over can't be brought to the owner later
  const notNow = closedTo(client, access);
  if (notNow) return refuse(notNow);
  if (one('response_type') !== 'code') return refuse('The app asked for a kind of access Paperwork doesn’t offer (response_type must be code).');
  const challenge = one('code_challenge');
  if (!challenge || one('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return refuse('The app didn’t secure its request with PKCE (code_challenge_method S256), which Paperwork requires.');
  }
  const resource = one('resource');
  if (resource !== undefined && !sameResource(resource)) return refuse(`The app asked for access to ${resource}; this Paperwork grants access to ${mcpUrl()}.`);
  const state = one('state');

  const user = await currentUser(req);
  if (!user) return res.redirect(`/auth/signin?next=${encodeURIComponent(req.originalUrl)}`);
  const ticket = await signTicket({ cid: client.id, ru: redirectUri, st: state, cc: challenge, em: user.email });
  const appTitle = knownApp(redirectUri) ?? client.name;
  const name = escapeHtml(appTitle);
  sendPage(
    res,
    200,
    `Connect ${appTitle} to Paperwork?`,
    `<p>${name} wants to search your documents and read what Paperwork knows about them: their text, summaries, companies, topics and deadlines. It can’t change or delete anything.</p>
<dl><dt>Access goes to</dt><dd><span class="to">${escapeHtml(destination(redirectUri))}</span></dd><dt>Signed in as</dt><dd>${escapeHtml(user.email)}</dd></dl>
<p class="warn">Only allow this if you just started connecting Paperwork in ${name}. You can disconnect it any time in Paperwork’s settings.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="${escapeHtml(ticket)}"><button name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="allow">Allow</button></form>`,
    redirectUri
  );
}

// Why an app can't be allowed in now, or null: an app that registered itself only while the owner has "Connect an
// AI app" open (one added by hand in Settings any time), and never one registered with an older Paperwork
function closedTo(client: Client, access: StoredAccess): string | null {
  if (client.id.startsWith('pwc.')) return 'This app registered with an older Paperwork. Remove Paperwork in the app, then connect it again.';
  if (!client.manual && !windowOpen(access)) return 'In Paperwork press Settings › AI assistants › Connect an AI app first, then connect again within 15 minutes.';
  return null;
}

async function answer(req: Request, res: Response) {
  const ticket = await readTicket(req.body?.ticket);
  const user = await currentUser(req);
  const client = ticket && (await findClient(ticket.cid));
  if (!ticket || !client || !user || user.email !== ticket.em) {
    return sendPage(res, 400, 'This page has expired', '<p>Start connecting Paperwork again in the app.</p>');
  }
  const back = (params: Record<string, string>) => res.redirect(303, withParams(ticket.ru, { ...params, state: ticket.st, iss: issuer() }));
  const appTitle = knownApp(ticket.ru) ?? client.name;
  if (req.body?.decision !== 'allow') {
    note(null, appTitle, false, `Cancelled by ${user.email}`);
    return back({ error: 'access_denied', error_description: 'Connecting Paperwork was cancelled.' });
  }
  // Switched off in Settings, or the window closed, since the page was shown
  const app = appOf(ticket.ru)?.id ?? null;
  const access = await readAccess();
  if (!isAllowedApp(access, app)) {
    note(null, appTitle, false, `Allowing refused: ${appTitle} is switched off in Settings`);
    return problemPage(res, `${appTitle} may not connect to Paperwork at the moment (Settings › AI assistants).`);
  }
  const notNow = closedTo(client, access);
  if (notNow) {
    note(null, appTitle, false, `Allowing refused: ${notNow}`);
    return problemPage(res, notNow);
  }
  // When the window now open was opened
  const openedAt = access.registrationUntil ? Date.parse(access.registrationUntil) - WINDOW_MS : null;
  const id = crypto.randomBytes(12).toString('hex');
  const code = `${id}.${random(32)}`;
  const now = Date.now();
  const grant: Grant = {
    id,
    client: client.id,
    app,
    name: appTitle,
    host: destination(ticket.ru),
    email: user.email,
    createdAt: new Date(now).toISOString(),
    lastUsedAt: null,
    code: { hash: sha256(code), expiresAt: now + CODE_MS, redirectUri: ticket.ru, challenge: ticket.cc },
    refresh: [],
  };
  await grants.change(list => {
    // Not twice when tried again
    if (!list.some(g => g.id === grant.id)) list.push(grant);
  });
  note(null, appTitle, true, `Allowed by ${user.email}; the code went to ${destination(ticket.ru)}, for the app to trade for tokens`);
  // The app is connected: no more registering until the owner opens the window again, and whatever else registered
  // while it was open is forgotten, so it can't be allowed in through a later window
  await closeRegistration().catch(err => console.warn('Closing the window for connecting AI apps failed:', (err as Error)?.message));
  if (openedAt !== null) {
    await keepClient(null, openedAt).catch(err => console.warn('Forgetting the other apps registered in the window failed:', (err as Error)?.message));
  }
  back({ code });
}

// ---------- Settings: the apps allowed, and the window for connecting one ----------

export async function allowApps(apps: unknown, email: string): Promise<void> {
  const access = await setApps(apps, email);
  note(null, 'Paperwork', true, `Allowed apps changed by ${email}: ${appNames(access.apps)}`);
  await keepClient(null);
}

export async function changeRegistration(open: boolean, email: string): Promise<void> {
  if (!open) {
    await closeRegistration();
    return;
  }
  await openRegistration(email);
  await keepClient(null);
}

// ---------- Routes ----------

// Apps may call these from a browser too: they carry no cookies, so any site may
export function openCors(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version');
  if (req.method !== 'OPTIONS') return next();
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
}

// Under /.well-known
export const wellKnownRouter = express.Router();
wellKnownRouter.use(openCors);

wellKnownRouter.get(['/oauth-protected-resource', '/oauth-protected-resource/mcp'], (_req, res) => {
  res.json({
    resource: mcpUrl(),
    authorization_servers: [issuer()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Paperwork',
  });
});

wellKnownRouter.get(['/oauth-authorization-server', '/oauth-authorization-server/mcp'], (_req, res) => {
  const base = issuer();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  });
});

// Under /oauth: what apps call themselves (the edge serves these), and the page asking the owner (the app)
export const machineOAuthRouter = express.Router();
export const consentRouter = express.Router();
const form = [express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' })];

// Read as text whatever the content type says, and parsed in register()
machineOAuthRouter.post('/register', openCors, express.text({ type: () => true, limit: '64kb' }), register);
consentRouter.get('/authorize', authorize);
consentRouter.post('/authorize', express.urlencoded({ extended: false, limit: '16kb' }), answer);

machineOAuthRouter.options(['/token', '/revoke', '/register'], openCors);

machineOAuthRouter.post('/token', openCors, ...form, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const client = await authenticate(req);
    if (!isAllowedApp(await readAccess(), appOfUris(client.redirectUris))) {
      throw new OAuthError('unauthorized_client', `Paperwork doesn’t accept ${client.name} at the moment (Settings › AI assistants).`, 400, client);
    }
    if (body.resource !== undefined && !(typeof body.resource === 'string' && sameResource(body.resource))) {
      throw new OAuthError('invalid_target', `Paperwork grants access to ${mcpUrl()} only.`, 400, client);
    }
    if (body.grant_type === 'authorization_code') {
      const tokens = await redeemCode(client, body).catch(err => {
        throw err instanceof OAuthError ? new OAuthError(err.code, err.message, err.status, client) : err;
      });
      note(null, client.name, true, 'Connected: traded its code for tokens');
      return res.json(tokens);
    }
    if (body.grant_type === 'refresh_token') {
      return res.json(
        await refresh(client, body).catch(err => {
          throw err instanceof OAuthError ? new OAuthError(err.code, err.message, err.status, client) : err;
        })
      );
    }
    throw new OAuthError('unsupported_grant_type', `Use authorization_code or refresh_token (the app sent ${JSON.stringify(body.grant_type ?? null)}).`, 400, client);
  } catch (err) {
    if (err instanceof OAuthError) {
      // Apps Paperwork knows are noted for Settings; anyone else's attempts only go to the log
      const what = `Token refused (${String(body.grant_type ?? 'no grant_type')}): ${err.code}: ${err.message}`;
      if (err.client) note(req, err.client.name, false, what);
      else console.warn(`AI app token request: ${what}`);
      if (err.status === 401 && req.get('authorization')?.startsWith('Basic ')) res.setHeader('WWW-Authenticate', 'Basic realm="Paperwork"');
      return sendError(res, err);
    }
    console.error('Issuing a token to an AI app failed:', err);
    res.status(500).json({ error: 'server_error', error_description: 'Something went wrong. Please try again.' });
  }
});

// RFC 7009: whatever the token, the answer is the same
machineOAuthRouter.post('/revoke', openCors, ...form, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  try {
    const gid = REFRESH_TOKEN.exec(token)?.[1];
    if (gid) {
      if ((await grants.read(true)).some(g => g.id === gid && g.refresh.includes(sha256(token)))) await disconnect(gid);
    } else if (token) {
      const access = await verifyAccess(token, { anyApp: true });
      if (access) await disconnect(access.grantId);
    }
  } catch (err) {
    console.error('Revoking an AI app’s token failed:', err);
    return res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Please try again.' });
  }
  res.status(200).end();
});

// Both, as one service serves them
export const oauthRouter = express.Router();
oauthRouter.use(machineOAuthRouter, consentRouter);

// On the edge, GET /oauth/authorize: the owner's browser, sent on to the page in the app with the request as it came.
// The address is fixed, only the query is passed on, so this can't lead anywhere else.
export function authorizeRedirect(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.originalUrl.length > 8000) return res.status(400).type('text/plain').send('This request is too long.');
  const at = req.originalUrl.indexOf('?');
  res.status(302).setHeader('Location', `${config.appUrl}/oauth/authorize${at >= 0 ? req.originalUrl.slice(at) : ''}`);
  res.end();
}

// For tests
export function forgetGrants() {
  grants.forget();
  clients.forget();
  events.forget();
  noted.clear();
  refusalNotedAt = 0;
}
