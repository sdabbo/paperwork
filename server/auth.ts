// Who is calling: a signed-in, allowed Google account (session cookie), or Cloud Scheduler (Google ID token).
//
// The session is a signed cookie (HttpOnly, SameSite=Lax); the allow-list is checked on every request, so
// removing an address from ALLOWED_EMAILS locks it out at once. Requests that change something must also
// carry the X-Paperwork header, which other sites can't add to a request on their own.
import { NextFunction, Request, Response } from 'express';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';
import { deriveKey } from './crypto.js';
import { GoogleUser } from './google.js';

const SESSION_COOKIE = 'pw_session';
const OAUTH_COOKIE = 'pw_oauth';
const SESSION_DAYS = 30;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    try {
      out[key] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      // Malformed value: ignored
    }
  }
  return out;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    config.isProduction ? 'Secure' : null,
    `Max-Age=${maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join('; ');
}

async function sign(payload: Record<string, unknown>, expiresIn: string): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresIn).sign(deriveKey('session'));
}

async function verify<T>(token: string | undefined): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, deriveKey('session'), { algorithms: ['HS256'] });
    return payload as T;
  } catch {
    return null;
  }
}

export function isAllowed(email: string): boolean {
  return config.allowedEmails.has(email.toLowerCase()) || (!config.isProduction && config.allowedEmails.size === 0);
}

// ---------- Session ----------

export async function startSession(res: Response, user: GoogleUser) {
  const token = await sign({ email: user.email, name: user.name, picture: user.picture }, `${SESSION_DAYS}d`);
  res.append('Set-Cookie', cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400));
}

export function endSession(res: Response) {
  res.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
}

export async function currentUser(req: Request): Promise<GoogleUser | null> {
  const user = await verify<GoogleUser>(parseCookies(req.get('cookie'))[SESSION_COOKIE]);
  return user && isAllowed(user.email) ? { email: user.email, name: user.name, picture: user.picture ?? null } : null;
}

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.', code: 'signed_out' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-paperwork') !== '1') {
    return res.status(403).json({ error: 'Missing request header.' });
  }
  res.locals.user = user;
  next();
}

// ---------- OAuth round trip ----------

export interface OAuthState {
  state: string;
  verifier: string;
  purpose: 'signin' | 'connect';
  // Where to go after signing in: the page a link pointed at, or an AI app's request to connect (oauth.ts)
  next?: string;
}

// A path on this site, never another site: "/x" but not "//host" or "/\\host", which browsers read as one, and short
// enough to ride along in the sign-in cookie
export function localPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2500 || !/^\/(?![/\\])/.test(value) || /[\u0000-\u001f\\]/.test(value)) return null;
  return value;
}

export async function rememberOAuth(res: Response, value: OAuthState) {
  res.append('Set-Cookie', cookie(OAUTH_COOKIE, await sign({ ...value }, '10m'), 600));
}

export async function takeOAuth(req: Request, res: Response): Promise<OAuthState | null> {
  res.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0));
  return verify<OAuthState>(parseCookies(req.get('cookie'))[OAUTH_COOKIE]);
}

// ---------- Cloud Scheduler ----------

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

// True for Cloud Scheduler's calls: a Google-signed token for CRON_SERVICE_ACCOUNT, issued for this service
export async function verifySchedulerToken(authHeader: string | undefined): Promise<boolean> {
  const account = process.env.CRON_SERVICE_ACCOUNT;
  const audience = process.env.CRON_AUDIENCE || config.publicUrl;
  if (!account || !audience || !authHeader?.startsWith('Bearer ')) return false;
  try {
    const { payload } = await jwtVerify(authHeader.slice('Bearer '.length), GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience,
      algorithms: ['RS256'],
    });
    return payload.email === account && payload.email_verified === true;
  } catch {
    return false;
  }
}
