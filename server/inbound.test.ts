// The door forwarded email comes through (inbound.ts): the secret before the body, at most 30 MB, only a message or
// Postmark's JSON, and errors that make the mail service try again later.
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundEmail, ReceiveResult } from './email.js';

const h = vi.hoisted(() => ({
  receive: null as unknown as (email: InboundEmail) => Promise<ReceiveResult>,
}));

vi.mock('./email.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./email.js')>();
  return { ...actual, receiveEmail: (email: InboundEmail) => h.receive(email) };
});

const { inboundEmail } = await import('./inbound.js');
const { VaultProblem } = await import('./vault.js');
const { NotConnectedError } = await import('./google.js');

const SECRET = 's3cret-value';
const MB = 1024 * 1024;
const RAW = ['From: Me <me@example.com>', 'To: paperwork@example.com', 'Subject: Scan', 'Message-ID: <m1@example.com>', '', 'See the scan.'].join('\r\n');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.post('/inbound/email', ...inboundEmail);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.INBOUND_EMAIL_SECRET;
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  process.env.INBOUND_EMAIL_SECRET = SECRET;
  h.receive = vi.fn(async () => ({ status: 'added', results: [{ status: 'waiting', inboxItem: { id: 'f1', name: 'Scan.pdf', mimeType: 'application/pdf', addedAt: '', state: 'waiting', error: null, webViewLink: '' } }] }) as ReceiveResult);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

// A request as a mail service sends it. `send` may be less than the declared Content-Length, and then the request is
// never finished: an answer can only come from a server that didn't wait for the body.
function post(headers: Record<string, string>, send: Buffer, options: { path?: string; end?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request(`${base}${options.path ?? '/inbound/email'}`, { method: 'POST', headers }, res => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        req.destroy();
      });
    });
    // The server closing the connection while the rest is still being sent is expected once it has answered
    req.on('error', err => {
      if (!answered) reject(err);
    });
    req.write(send);
    if (options.end !== false) req.end();
  });
}

const bearer = { authorization: `Bearer ${SECRET}` };

describe('who may post', () => {
  it('turns away a caller without the secret before reading anything it sends, and closes the connection', async () => {
    const callers: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: `Basic ${Buffer.from('inbound:wrong').toString('base64')}` }];
    for (const headers of callers) {
      // 40 MB announced, 1 KB sent, never finished: a body parser would wait (or answer 413)
      const res = await post({ ...headers, 'content-type': 'message/rfc822', 'content-length': String(40 * MB) }, Buffer.alloc(1024, 65), { end: false });
      expect(res.status).toBe(401);
      expect(res.headers.connection).toBe('close');
      expect(JSON.parse(res.text)).toEqual({ error: 'Not authorized' });
    }
    // The same for a small body that never arrives in full
    const res = await post({ 'content-type': 'application/json', 'content-length': '1000' }, Buffer.from('{"From"'), { end: false });
    expect(res.status).toBe(401);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it('no longer takes the secret in the address', async () => {
    const res = await post({ 'content-type': 'message/rfc822' }, Buffer.from(RAW), { path: `/inbound/email?token=${SECRET}` });
    expect(res.status).toBe(401);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it('takes the Cloudflare worker’s Bearer token and the password in Postmark’s webhook address', async () => {
    const raw = await post({ ...bearer, 'content-type': 'message/rfc822' }, Buffer.from(RAW));
    expect(raw.status).toBe(200);
    expect(JSON.parse(raw.text)).toEqual({ status: 'added', documents: [{ status: 'waiting', title: 'Scan.pdf' }] });
    expect(vi.mocked(h.receive).mock.calls[0][0]).toMatchObject({ from: 'me@example.com', subject: 'Scan' });

    const postmark = JSON.stringify({ FromFull: { Email: 'me@example.com' }, Subject: 'Postmark scan', Attachments: [] });
    const json = await post({ authorization: `Basic ${Buffer.from(`inbound:${SECRET}`).toString('base64')}`, 'content-type': 'application/json' }, Buffer.from(postmark));
    expect(json.status).toBe(200);
    expect(vi.mocked(h.receive).mock.calls[1][0]).toMatchObject({ from: 'me@example.com', subject: 'Postmark scan' });
  });

  it('turns everyone away when the server has no secret', async () => {
    delete process.env.INBOUND_EMAIL_SECRET;
    expect((await post({ authorization: 'Bearer ', 'content-type': 'message/rfc822' }, Buffer.from(RAW))).status).toBe(401);
  });
});

describe('what may be posted', () => {
  it('refuses more than 30 MB', async () => {
    const res = await post({ ...bearer, 'content-type': 'message/rfc822' }, Buffer.alloc(31 * MB, 65));
    expect(res.status).toBe(413);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it('takes a message of almost 30 MB', async () => {
    const big = Buffer.concat([Buffer.from(`${RAW}\r\n`), Buffer.alloc(29 * MB, 65)]);
    expect((await post({ ...bearer, 'content-type': 'message/rfc822' }, big)).status).toBe(200);
  });

  it('refuses what is neither a message nor Postmark’s JSON', async () => {
    expect((await post({ ...bearer, 'content-type': 'image/png' }, Buffer.from('\x89PNG'))).status).toBe(415);
    expect((await post({ ...bearer, 'content-type': 'application/json' }, Buffer.from('{}'))).status).toBe(415);
    expect((await post({ ...bearer, 'content-type': 'message/rfc822' }, Buffer.alloc(0))).status).toBe(415);
    expect(h.receive).not.toHaveBeenCalled();
  });
});

describe('when it fails', () => {
  it('asks the mail service to try again later while Drive is missing or not connected', async () => {
    h.receive = async () => {
      throw new VaultProblem("Paperwork's folder in Google Drive wasn't found. Open Paperwork once, then try again.");
    };
    const missing = await post({ ...bearer, 'content-type': 'message/rfc822' }, Buffer.from(RAW));
    expect(missing.status).toBe(503);
    expect(JSON.parse(missing.text).error).toContain("wasn't found");

    h.receive = async () => {
      throw new NotConnectedError();
    };
    expect((await post({ ...bearer, 'content-type': 'message/rfc822' }, Buffer.from(RAW))).status).toBe(503);

    h.receive = async () => {
      throw new Error('Drive is down');
    };
    expect((await post({ ...bearer, 'content-type': 'message/rfc822' }, Buffer.from(RAW))).status).toBe(500);
  });

  it('turns away a sender who may not send documents', async () => {
    h.receive = async () => ({ status: 'sender-not-allowed', results: [] });
    expect((await post({ ...bearer, 'content-type': 'message/rfc822' }, Buffer.from(RAW))).status).toBe(403);
  });
});
