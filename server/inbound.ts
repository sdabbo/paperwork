// Forwarded email (see server/email.ts): a raw message from the Cloudflare worker, or Postmark's JSON.
//
// On the public edge this is a door anyone can knock on, so the secret is checked before a byte of the body is
// read: a caller without it gets 401 and the connection is closed, so the rest of what it sends is never read.
import express, { NextFunction, Request, Response } from 'express';
import { authorized, parsePostmark, parseRaw, receiveEmail } from './email.js';
import { NotConnectedError } from './google.js';
import { VaultProblem } from './vault.js';

// As uploads (routes.ts): within what Cloud Run takes in one request over HTTP/1 (32 MiB)
const LIMIT = '30mb';

function requireInboundSecret(req: Request, res: Response, next: NextFunction) {
  if (authorized(req)) return next();
  // Without "Connection: close", Node would read the rest of the body to keep the connection for another request
  res.set('Connection', 'close').status(401).json({ error: 'Not authorized' });
}

async function receive(req: Request, res: Response) {
  // Neither a raw message nor Postmark's JSON (another content type, or nothing at all)
  const raw = Buffer.isBuffer(req.body);
  if (raw ? !req.body.length : !(req.body && typeof req.body === 'object' && Object.keys(req.body).length)) {
    return res.status(415).json({ error: 'Send message/rfc822 or Postmark JSON.' });
  }
  try {
    const email = raw ? await parseRaw(new Uint8Array(req.body)) : parsePostmark(req.body);
    const result = await receiveEmail(email);
    res.status(result.status === 'sender-not-allowed' ? 403 : 200).json({
      status: result.status,
      documents: result.results.map(r => ({ status: r.status, title: r.document?.title ?? r.duplicateOf?.title ?? r.inboxItem?.name, error: r.error })),
    });
  } catch (err: any) {
    console.error('Receiving an email failed:', err);
    // An error makes the sender retry later, e.g. after Drive was reconnected; one that waits on Drive says so
    const later = err instanceof VaultProblem || err instanceof NotConnectedError;
    res.status(later ? 503 : 500).json({ error: err.message });
  }
}

// For POST /inbound/email: the secret first, then the body (at most 30 MB)
export const inboundEmail = [
  requireInboundSecret,
  express.raw({ type: ['message/rfc822', 'text/plain', 'application/octet-stream'], limit: LIMIT }),
  express.json({ limit: LIMIT }),
  receive,
];
