// The scheduled run when Paperwork runs as two services (roles.ts). Cloud Scheduler can only call with a Google ID
// token, which the Identity-Aware Proxy in front of the app doesn't take from machines. So Scheduler calls the public
// edge, which checks its token as before (cron.ts) and passes the run on to the app through IAP as its own service
// account (CRON_RELAY_ACCOUNT): it has Google sign a short-lived JWT for the app's address (IAM Credentials signJwt)
// and sends it as a Bearer token. IAP lets that account through to exactly POST /internal/cron (iap.ts), where the
// app files and answers with the run's summary.
//
// Not yet tried end to end on Google Cloud, so each step logs one line ("Cron relay", phase metadata, signJwt or
// call) with what came back, never a token or the JWT. Should it fail, the app still files whenever it is opened.
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from './config.js';

const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const signJwtUrl = (account: string) => `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:signJwt`;
// How long the signed JWT is good for (IAP takes at most an hour)
const JWT_SECONDS = 300;
// The metadata server and IAM Credentials answer quickly or not at all
const QUICK_TIMEOUT_MS = 10_000;
// A run takes up to ~5 minutes; this stays under Cloud Scheduler's 600 s deadline and the edge's own timeout
export const CALL_TIMEOUT_MS = 570_000;
// The metadata server's token is used until a minute before it runs out
const TOKEN_MARGIN_MS = 60_000;

// The app answers only once the run is done, and Node's own fetch stops waiting for an answer's headers after 300 s
// whatever the signal says: the call to the app goes through a dispatcher that waits as long as CALL_TIMEOUT_MS
let longCalls: Agent | null = null;
const longCall = () => (longCalls ??= new Agent({ headersTimeout: CALL_TIMEOUT_MS, bodyTimeout: CALL_TIMEOUT_MS }));

export type RelayPhase = 'metadata' | 'signJwt' | 'call';

export interface RelayResult {
  status: number;
  body: unknown;
}

// The edge's access token from the metadata server, kept between runs
let metadataToken: { token: string; until: number } | null = null;

export function forgetRelayToken() {
  metadataToken = null;
}

// A step that went wrong: which, and the HTTP status it got (0 when there was no answer)
class RelayFailed extends Error {
  constructor(
    readonly phase: RelayPhase,
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

interface Deps {
  fetch?: typeof fetch;
  now?: () => number;
}

export async function relayCron(deps: Deps = {}): Promise<RelayResult> {
  const send = deps.fetch ?? (undiciFetch as unknown as typeof fetch);
  const now = deps.now ?? Date.now;
  // Whatever must never reach the logs, in case an answer echoes it
  const secrets: string[] = [];
  const log = (severity: 'INFO' | 'ERROR', phase: RelayPhase, fields: Record<string, unknown>) => {
    let line = JSON.stringify({ severity, message: 'Cron relay', phase, ...fields });
    for (const secret of secrets) line = line.split(secret).join('[redacted]');
    console.log(line);
  };
  // A request of one step, timed, with no answer turned into a failure of that step
  const request = async (phase: RelayPhase, url: string, init: RequestInit) => {
    const started = Date.now();
    try {
      const res = await send(url, init);
      return { res, ms: Date.now() - started };
    } catch (err) {
      log('ERROR', phase, { status: 0, ms: Date.now() - started, error: (err as Error)?.message ?? String(err) });
      throw new RelayFailed(phase, 0, `No answer: ${(err as Error)?.message ?? err}`);
    }
  };
  // An answer that isn't what the step needs: logged with the start of what came back
  const failed = async (phase: RelayPhase, res: Response, ms: number, why: string, extra: Record<string, unknown> = {}) => {
    const body = res.ok ? undefined : (await res.text().catch(() => '')).slice(0, 300);
    log('ERROR', phase, { status: res.status, ms, error: why, ...extra, ...(body !== undefined ? { body } : {}) });
    return new RelayFailed(phase, res.status, why);
  };

  let phase: RelayPhase = 'metadata';
  try {
    // 1. The edge's own access token
    let token = metadataToken && metadataToken.until > now() ? metadataToken.token : null;
    if (token) {
      log('INFO', 'metadata', { cached: true });
    } else {
      const { res, ms } = await request('metadata', METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(QUICK_TIMEOUT_MS) });
      const answer = res.ok ? ((await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null) : null;
      if (typeof answer?.access_token !== 'string' || !answer.access_token) throw await failed('metadata', res, ms, res.ok ? 'No access token in the answer' : 'Refused');
      token = answer.access_token;
      const seconds = Number(answer.expires_in) || 0;
      metadataToken = { token, until: now() + seconds * 1000 - TOKEN_MARGIN_MS };
      log('INFO', 'metadata', { status: res.status, ms, cached: false, expiresIn: seconds });
    }
    secrets.push(token);

    // 2. A JWT for the app's address, signed by Google as the edge's service account
    phase = 'signJwt';
    const account = config.cronRelayAccount;
    if (!account) {
      log('ERROR', 'signJwt', { status: 0, error: 'CRON_RELAY_ACCOUNT is not set' });
      throw new RelayFailed('signJwt', 0, 'CRON_RELAY_ACCOUNT is not set');
    }
    const iat = Math.floor(now() / 1000);
    const audience = config.cronRelayAudience;
    const claims = { iss: account, sub: account, aud: audience, iat, exp: iat + JWT_SECONDS };
    const signed = await request('signJwt', signJwtUrl(account), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify(claims) }),
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
    // A token Google no longer takes is fetched again next time
    if (signed.res.status === 401) forgetRelayToken();
    const jwt = signed.res.ok ? ((await signed.res.json().catch(() => null)) as { keyId?: unknown; signedJwt?: unknown } | null) : null;
    if (typeof jwt?.signedJwt !== 'string' || !jwt.signedJwt) {
      throw await failed('signJwt', signed.res, signed.ms, signed.res.ok ? 'No signed JWT in the answer' : 'Refused', { account, audience });
    }
    secrets.push(jwt.signedJwt);
    log('INFO', 'signJwt', { status: signed.res.status, ms: signed.ms, account, audience, keyId: jwt.keyId });

    // 3. The app, through IAP. A redirect is IAP asking for a person's sign-in: the JWT wasn't taken.
    phase = 'call';
    const called = await request('call', `${config.appUrl}/internal/cron`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt.signedJwt}`, 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      dispatcher: longCall(),
    } as RequestInit);
    const { res, ms } = called;
    const iap = {
      iapGenerated: res.headers.get('x-goog-iap-generated-response'),
      location: res.headers.get('location'),
      wwwAuthenticate: res.headers.get('www-authenticate'),
    };
    const text = await res.text().catch(() => '');
    let summary: unknown;
    try {
      summary = JSON.parse(text);
    } catch {
      summary = undefined;
    }
    if (!res.ok || typeof summary !== 'object' || summary === null) {
      log('ERROR', 'call', { status: res.status, ms, error: res.ok ? 'The app did not answer with JSON' : 'Refused', ...iap, body: text.slice(0, 300) });
      throw new RelayFailed('call', res.status, 'The app did not run it');
    }
    const s = summary as Record<string, unknown>;
    log('INFO', 'call', {
      status: res.status,
      ms,
      iapGenerated: iap.iapGenerated,
      summary: { filed: s.filed, duplicates: s.duplicates, failed: s.failed, waiting: s.waiting, indexed: s.indexed, ...(s.skipped ? { skipped: s.skipped } : {}) },
    });
    return { status: 200, body: summary };
  } catch (err) {
    if (err instanceof RelayFailed) return { status: 502, body: { error: 'relay failed', phase: err.phase, status: err.status } };
    // Anything unforeseen still answers Scheduler with a failure, never a token
    log('ERROR', phase, { status: 0, error: (err as Error)?.message ?? String(err) });
    return { status: 502, body: { error: 'relay failed', phase, status: 0 } };
  }
}
