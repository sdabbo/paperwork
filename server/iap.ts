// Google's Identity-Aware Proxy in front of the owner's app (role 'app', roles.ts). IAP lets in only Google accounts
// it was told to (after Google's sign-in) and signs each request it passes on in x-goog-iap-jwt-assertion. The app
// checks that header on every request, before anything else runs, and refuses what IAP didn't sign: if IAP were ever
// switched off, or the service opened to everyone, nothing would be served (fail closed).
//
// - The owner: an account in ALLOWED_EMAILS, anywhere but /internal/cron and the feed below. Paperwork's own sign-in
//   still follows.
// - The scheduled run, relayed by the edge as its service account (CRON_RELAY_ACCOUNT): exactly POST /internal/cron
//   and nothing else.
// - Finance, the owner's finance app, as its own service account (FINANCE_READER_ACCOUNT): exactly GET on the two
//   paths of the read-only feed (FINANCE_PATHS, finance.ts) and nothing else; nobody else may use those paths.
// Paths are compared exactly as sent (Express's req.path, undecoded), so "/internal/finance%2Fcontracts", a trailing
// "/", dot segments or doubled slashes match nothing: a request.path condition on IAP's grant (protect.sh finance)
// could let those through, so this exact match is the check that counts.
// Google's unsigned x-goog-* headers are never read.
import { NextFunction, Request, Response } from 'express';
import { JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, errors, jwtVerify } from 'jose';
import { currentUser } from './auth.js';

export const IAP_ISSUER = 'https://cloud.google.com/iap';
const IAP_KEYS = 'https://www.gstatic.com/iap/verify/public_key-jwk';
// IAP's own allowance for clocks that differ
const CLOCK_TOLERANCE_S = 30;

export interface IapPrincipal {
  email: string;
  sub: string;
  principal: 'owner' | 'relay' | 'finance';
}

// The read-only feed for Finance (finance.ts), the only paths its account may call, and only with GET
export const FINANCE_PATHS = ['/internal/finance/contracts', '/internal/finance/purchases'] as const;
const FEED_PREFIX = '/internal/finance';

// A path as some route might still read it: decoded, in lower case, doubled slashes as one. Only used to refuse
// everyone but Finance anywhere near the feed; Finance itself must send the exact path.
function loosely(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Not valid percent-encoding: as sent
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, '/');
}

// Google's keys, fetched once per process and cached by jose (fetched again for a key it doesn't know yet)
let keys: JWTVerifyGetKey | null = null;
const iapKeys = () => (keys ??= createRemoteJWKSet(new URL(IAP_KEYS)));

export function setIapKeysForTests(next: JWTVerifyGetKey | null) {
  keys = next;
}

// The keys couldn't be fetched: nothing can be checked, so nothing is let in, but it isn't the caller's fault
class KeysUnavailable extends Error {}

// Problems with the key set itself (unreachable, not JSON, timed out) as opposed to a token no key fits
const KEY_SET_PROBLEMS = new Set(['ERR_JOSE_GENERIC', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID']);

const log = (severity: 'INFO' | 'WARNING' | 'ERROR', message: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ severity, message, ...fields }));

export function iapGate(options: {
  audience: string;
  allowedEmails: () => Set<string>;
  relayAccount: string;
  // Finance's service account (config.financeReaderAccount); empty: the feed is off and nobody may call it
  financeAccount?: string;
  keys?: JWTVerifyGetKey;
}) {
  let relaySeen = false;
  let financeSeen = false;
  const financeAccount = options.financeAccount ?? '';
  let mismatchSeen = false;

  const getKey: JWTVerifyGetKey = async (header, token) => {
    try {
      return await (options.keys ?? iapKeys())(header, token);
    } catch (err) {
      if (err instanceof errors.JOSEError && !KEY_SET_PROBLEMS.has(err.code)) throw err;
      throw new KeysUnavailable((err as Error)?.message ?? String(err));
    }
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const refuse = (reason: string, fields: Record<string, unknown> = {}) => {
      log('WARNING', 'IAP check failed', { reason, method: req.method, path: req.path, ...fields });
      res.status(403).set('Cache-Control', 'no-store').type('text/plain').send('Forbidden');
    };
    const assertion = req.get('x-goog-iap-jwt-assertion');
    if (!assertion) return refuse('missing header');
    // jose skips the audience check for an empty one: without it, nothing can be let in
    if (!options.audience) return refuse('IAP_AUDIENCE is not set');

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(assertion, getKey, { algorithms: ['ES256'], issuer: IAP_ISSUER, audience: options.audience, clockTolerance: CLOCK_TOLERANCE_S }));
    } catch (err) {
      if (err instanceof KeysUnavailable) {
        log('ERROR', 'IAP check failed', { reason: `keys unavailable: ${err.message}`, path: req.path });
        return res.status(503).set('Retry-After', '30').set('Cache-Control', 'no-store').type('text/plain').send('Service Unavailable');
      }
      const reason = err instanceof errors.JOSEError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err);
      // What the header was issued for, so a wrong IAP_AUDIENCE can be corrected from the log (claims only, never the token)
      let claims: Record<string, unknown> = {};
      try {
        const decoded = decodeJwt(assertion);
        claims = { aud: decoded.aud, iss: decoded.iss };
      } catch {
        // Not a JWT at all
      }
      return refuse(reason, claims);
    }

    // The signed claim is the bare address; the prefix belongs to IAP's unsigned header, removed should it appear
    const email = (typeof payload.email === 'string' ? payload.email : '').toLowerCase().replace(/^accounts\.google\.com:/, '');
    const sub = typeof payload.sub === 'string' ? payload.sub : '';

    if (req.method === 'POST' && req.path === '/internal/cron') {
      if (!options.relayAccount || email !== options.relayAccount) return refuse('only the relay account may call /internal/cron', { email });
      if (!relaySeen) {
        relaySeen = true;
        log('INFO', 'IAP relay accepted', { email, sub });
      }
      res.locals.iap = { email, sub, principal: 'relay' } satisfies IapPrincipal;
      return next();
    }
    // Finance reads the feed and nothing else, even if its account were also listed in ALLOWED_EMAILS
    if (financeAccount && email === financeAccount) {
      if (req.method !== 'GET' || !(FINANCE_PATHS as readonly string[]).includes(req.path)) return refuse('the finance account may only read the feed', { email });
      if (!financeSeen) {
        financeSeen = true;
        log('INFO', 'IAP finance accepted', { email, sub });
      }
      res.locals.iap = { email, sub, principal: 'finance' } satisfies IapPrincipal;
      return next();
    }
    // In any spelling, so no other route can ever answer there: not the owner, not the relay, nobody
    if (loosely(req.path).startsWith(FEED_PREFIX)) return refuse('the feed is for the finance account only', { email });
    if (!email || email === options.relayAccount || !options.allowedEmails().has(email)) return refuse('account not allowed', { email });
    res.locals.iap = { email, sub, principal: 'owner' } satisfies IapPrincipal;

    // Several allowed accounts may share a device, so IAP's account and Paperwork's sign-in aren't tied together;
    // a difference is noted once, to understand what happened should it matter
    if (!mismatchSeen) {
      const user = await currentUser(req).catch(() => null);
      if (user && user.email.toLowerCase() !== email) {
        mismatchSeen = true;
        log('INFO', 'IAP account differs from the Paperwork sign-in', { iap: email, session: user.email });
      }
    }
    next();
  };
}
