// Keys derived from APP_SECRET: one signs session cookies, one encrypts the Google refresh token at rest, one
// signs what AI apps are given to reach the MCP server (oauth.ts). The refresh token opens the owner's Drive, so
// it is never stored in plain text, not even in Firestore.
import crypto from 'crypto';
import { config } from './config.js';

const DEV_SECRET = 'paperwork-local-development-secret-do-not-deploy';

function appSecret(): string {
  const secret = process.env.APP_SECRET || '';
  if (secret.length >= 32) return secret;
  if (config.isProduction) throw new Error('APP_SECRET must be set (at least 32 characters).');
  return DEV_SECRET;
}

export function deriveKey(purpose: 'session' | 'token' | 'mcp'): Uint8Array {
  return new Uint8Array(crypto.hkdfSync('sha256', appSecret(), 'paperwork', purpose, 32));
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('token'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map(p => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unknown encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('token'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export const md5 = (data: Uint8Array) => crypto.createHash('md5').update(data).digest('hex');
export const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

// Compares secrets without leaking their length or content through timing
export function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length > 0;
}
