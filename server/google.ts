// Google sign-in and the Drive connection.
//
// Two consents, both through Google's OAuth web flow (with PKCE):
// - Signing in asks only for name and email. Every allowed account can sign in this way.
// - Connecting Drive (once, by the owner) asks for Drive access with a refresh token, so the server can file
//   documents while nobody has the app open. The refresh token is encrypted (crypto.ts) and kept in the store.
import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { getStore } from './store.js';
import { Drive } from './drive.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export const SIGN_IN_SCOPES = ['openid', 'email', 'profile'];

const DRIVE_FULL = 'https://www.googleapis.com/auth/drive';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

export function driveScope(): string {
  return config.driveAccess === 'app' ? DRIVE_FILE : DRIVE_FULL;
}

// What a connection's permission allows in Drive: everything, or only Paperwork's own and picked files
export function grantOf(scope: string | undefined): 'full' | 'app' | null {
  const scopes = (scope ?? '').split(' ');
  return scopes.includes(DRIVE_FULL) ? 'full' : scopes.includes(DRIVE_FILE) ? 'app' : null;
}

export const redirectUri = () => `${config.appUrl}/auth/callback`;

export class NotConnectedError extends Error {
  constructor(message = 'Google Drive is not connected yet.') {
    super(message);
  }
}

// ---------- OAuth ----------

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizationUrl(opts: { scopes: string[]; state: string; challenge: string; offline: boolean; loginHint?: string }): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', config.googleClientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', opts.scopes.join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (opts.offline) {
    // A refresh token is only handed out with consent; asking again also replaces a lost one
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  } else {
    url.searchParams.set('prompt', 'select_account');
  }
  if (opts.loginHint) url.searchParams.set('login_hint', opts.loginHint);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || `Google answered ${res.status}`);
    (err as any).code = body.error;
    throw err;
  }
  return body;
}

export function exchangeCode(code: string, verifier: string) {
  return tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri() });
}

export interface GoogleUser {
  email: string;
  name: string;
  picture: string | null;
}

export async function verifyIdToken(idToken: string): Promise<GoogleUser> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: config.googleClientId,
    algorithms: ['RS256'],
  });
  if (typeof payload.email !== 'string' || payload.email_verified !== true) throw new Error('Google did not confirm an email address.');
  return {
    email: payload.email.toLowerCase(),
    name: typeof payload.name === 'string' ? payload.name : payload.email,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  };
}

// ---------- The stored connection ----------

export interface Connection {
  ownerEmail: string;
  refreshToken: string; // encrypted
  scope: string;
  connectedAt: string;
  rootFolderId?: string;
  // Set when Google stopped accepting the refresh token (revoked, or the app was removed from the account)
  broken?: boolean;
}

export async function getConnection(): Promise<Connection | null> {
  const stored = await getStore().get<Connection>('connection');
  return stored?.refreshToken ? stored : null;
}

export async function saveConnection(owner: string, refreshToken: string, scope: string): Promise<void> {
  // Also what's left of an earlier, disconnected connection
  const previous = await getStore().get<Partial<Connection>>('connection');
  await getStore().set<Connection>('connection', {
    ownerEmail: owner,
    refreshToken: encrypt(refreshToken),
    scope,
    connectedAt: new Date().toISOString(),
    // Reconnecting the same account keeps the folder; another account starts its own
    ...(previous?.ownerEmail === owner && previous.rootFolderId ? { rootFolderId: previous.rootFolderId } : {}),
  });
  cachedToken = null;
}

// Only the folder is changed, whatever else changed meanwhile
export async function rememberRootFolder(rootFolderId: string): Promise<void> {
  await getStore().update<Connection, void>('connection', current => ({ next: current?.refreshToken ? { ...current, rootFolderId } : undefined, result: undefined }));
}

export async function forgetConnection(): Promise<void> {
  const connection = await getConnection();
  cachedToken = null;
  if (!connection) return;
  // Tell Google too, so the permission disappears from the owner's account
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(decrypt(connection.refreshToken))}`, { method: 'POST' });
  } catch (err) {
    console.warn('Could not revoke the Google token:', err);
  }
  // The folder is remembered, so connecting the same account again carries on with it
  await getStore().set('connection', { disconnectedAt: new Date().toISOString(), rootFolderId: connection.rootFolderId, ownerEmail: connection.ownerEmail });
}

// Why Google's file picker isn't offered to an account, if it isn't. The picker runs in the browser with a Drive
// token of the owner's, so it is only offered to the owner, and only while that token is limited to Paperwork's
// own and picked files: a token for the whole Drive never leaves the server.
export function pickerUnavailable(connection: Connection | null, email: string | undefined): string | null {
  if (config.driveAccess !== 'app') return 'Paperwork sees your whole Drive, so scans saved into its Inbox are filed without picking them.';
  if (!connection || connection.broken) return 'Connect Google Drive first.';
  if (connection.ownerEmail !== email) return `Only ${connection.ownerEmail}, whose Drive Paperwork uses, can pick files from it.`;
  if (grantOf(connection.scope) !== 'app') {
    return 'Paperwork is still connected with access to your whole Drive. Disconnect and connect Drive again in Settings to narrow it; then you can pick files.';
  }
  if (!config.pickerApiKey || !config.pickerAppId) return 'Picking files from Drive needs one more setup step: run deploy/setup.sh, then deploy/deploy.sh.';
  return null;
}

// The access token, with the connection it came from: Drive may be disconnected, or another account connected, in
// the other service (the app, while the edge serves AI apps), so that is checked again at least every minute
let cachedToken: { token: string; expiresAt: number; connectedAt: string; refreshToken: string; checkedAt: number } | null = null;
let refreshing: Promise<string> | null = null;
const RECHECK_MS = 60 * 1000;

export async function accessToken(fresh = false): Promise<string> {
  if (!fresh && cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    if (Date.now() - cachedToken.checkedAt < RECHECK_MS) return cachedToken.token;
    const connection = await getConnection();
    if (cachedToken && connection && !connection.broken && connection.connectedAt === cachedToken.connectedAt && connection.refreshToken === cachedToken.refreshToken) {
      cachedToken.checkedAt = Date.now();
      return cachedToken.token;
    }
    cachedToken = null;
  }
  refreshing ??= (async () => {
    const connection = await getConnection();
    if (!connection) throw new NotConnectedError();
    if (connection.broken) throw new NotConnectedError('Google stopped accepting Paperwork\'s access to Drive. Connect Drive again.');
    try {
      const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(connection.refreshToken) });
      const now = Date.now();
      cachedToken = { token: body.access_token, expiresAt: now + body.expires_in * 1000, connectedAt: connection.connectedAt, refreshToken: connection.refreshToken, checkedAt: now };
      return body.access_token;
    } catch (err: any) {
      if (err.code === 'invalid_grant') {
        // Marked broken only if it is still this token: the owner may have connected Drive again meanwhile
        await getStore().update<Connection, void>('connection', current => ({
          next: current && current.refreshToken === connection.refreshToken ? { ...current, broken: true } : undefined,
          result: undefined,
        }));
        throw new NotConnectedError('Google stopped accepting Paperwork\'s access to Drive. Connect Drive again.');
      }
      throw err;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function getDrive(): Drive {
  return new Drive({ accessToken });
}
