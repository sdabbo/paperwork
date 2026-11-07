import { afterEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { currentUser, isAllowed, localPath, parseCookies, requireUser, startSession } from './auth.js';
import { decrypt, encrypt } from './crypto.js';

function fakeRes() {
  const headers: string[] = [];
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    locals: {} as Record<string, unknown>,
    append: (_name: string, value: string) => headers.push(value),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return { res: res as unknown as Response & typeof res, headers };
}

const fakeReq = (cookie: string, method = 'GET', extra: Record<string, string> = {}) =>
  ({ method, get: (name: string) => ({ cookie, ...extra })[name.toLowerCase()] }) as unknown as Request;

afterEach(() => {
  delete process.env.ALLOWED_EMAILS;
});

describe('sessions', () => {
  it('round-trip through a signed cookie', async () => {
    process.env.ALLOWED_EMAILS = 'me@example.com';
    const { res, headers } = fakeRes();
    await startSession(res, { email: 'me@example.com', name: 'Me', picture: null });
    expect(headers[0]).toMatch(/^pw_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
    const cookie = headers[0].split(';')[0];
    expect(await currentUser(fakeReq(cookie))).toEqual({ email: 'me@example.com', name: 'Me', picture: null });
  });

  it('end when the account is taken off the allow-list', async () => {
    process.env.ALLOWED_EMAILS = 'me@example.com';
    const { res, headers } = fakeRes();
    await startSession(res, { email: 'me@example.com', name: 'Me', picture: null });
    process.env.ALLOWED_EMAILS = 'someone@example.com';
    expect(await currentUser(fakeReq(headers[0].split(';')[0]))).toBeNull();
  });

  it('reject forged cookies', async () => {
    process.env.ALLOWED_EMAILS = 'me@example.com';
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Im1lQGV4YW1wbGUuY29tIn0.c2lnbmF0dXJl';
    expect(await currentUser(fakeReq(`pw_session=${forged}`))).toBeNull();
  });

  it('require the app header for changes', async () => {
    process.env.ALLOWED_EMAILS = 'me@example.com';
    const { res: sessionRes, headers } = fakeRes();
    await startSession(sessionRes, { email: 'me@example.com', name: 'Me', picture: null });
    const cookie = headers[0].split(';')[0];

    const { res } = fakeRes();
    let passed = false;
    await requireUser(fakeReq(cookie, 'POST'), res, () => (passed = true));
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);

    await requireUser(fakeReq(cookie, 'POST', { 'x-paperwork': '1' }), fakeRes().res, () => (passed = true));
    expect(passed).toBe(true);
  });
});

describe('the allow-list', () => {
  it('is case-insensitive', () => {
    process.env.ALLOWED_EMAILS = ' Me@Example.com , other@example.com';
    expect(isAllowed('me@example.com')).toBe(true);
    expect(isAllowed('stranger@example.com')).toBe(false);
  });
});

describe('the page to return to after signing in', () => {
  it('is a path on this site', () => {
    expect(localPath('/?doc=abc123')).toBe('/?doc=abc123');
    expect(localPath('/oauth/authorize?client_id=pwc.x.y&state=s')).toBe('/oauth/authorize?client_id=pwc.x.y&state=s');
  });

  it('is never another site', () => {
    for (const value of ['//evil.example', '/\\evil.example', '/\\/evil.example', 'https://evil.example', 'evil', '/\tx', `/${'x'.repeat(3000)}`, undefined, ['/a']]) {
      expect(localPath(value)).toBeNull();
    }
  });
});

describe('cookies', () => {
  it('are parsed leniently', () => {
    expect(parseCookies('a=1; b=hello%20world; broken=%E0%A4%A; c')).toEqual({ a: '1', b: 'hello world' });
  });
});

describe('the stored Drive token', () => {
  it('is encrypted and tamper-proof', () => {
    const sealed = encrypt('1//refresh-token');
    expect(sealed).not.toContain('refresh');
    expect(decrypt(sealed)).toBe('1//refresh-token');
    const [v, iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });
});
