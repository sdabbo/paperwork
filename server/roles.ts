// Paperwork as one service (role 'all', PAPERWORK_ROLE unset) or as two from the same image (server/app.ts): the
// owner's app behind Google's Identity-Aware Proxy ('app') and the public edge for AI apps, forwarded email and Cloud
// Scheduler ('edge'). Both read and write one Firestore database, so what only one may do is guarded here: filing
// and writing the search index happen in the app (or the single service), never on the edge.
//
// A setting that would open a door, or route traffic to the wrong place, stops the server at start-up
// (configProblems): a revision that exits never becomes ready, so Cloud Run keeps serving the previous one.
import { config } from './config.js';

// Something only the app files or writes, asked of the edge
export class FilerOnly extends Error {}

export function assertFiler(what: string): void {
  if (config.role === 'edge') throw new FilerOnly(`${what} is done by Paperwork's app, not by its public edge.`);
}

const ROLES = ['', 'all', 'app', 'edge'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const IAP_AUDIENCE = /^\/projects\/\d+\/locations\/[a-z0-9-]+\/services\/[a-z0-9-]+$/;
// Exactly one service account: a list ("a@….iam.gserviceaccount.com,b@….iam.gserviceaccount.com") also ends in the
// suffix, so the whole value is matched
const SERVICE_ACCOUNT = /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

const list = (value: string | undefined) =>
  (value || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);

// What is wrong with the settings, one sentence each; empty when the server may start
export function configProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const role = env.PAPERWORK_ROLE ?? '';
  const production = env.NODE_ENV === 'production' || !!env.K_SERVICE;
  if (!ROLES.includes(role)) return [`PAPERWORK_ROLE is "${role}"; it must be app, edge, all, or unset.`];
  if (production && (env.APP_SECRET ?? '').length < 32) problems.push('APP_SECRET must be set (at least 32 characters).');
  if (role !== 'app' && role !== 'edge') return problems;

  // Both services know both addresses: the app's (sign-in, links) and the public one (AI apps, mail services)
  const address = (name: 'APP_URL' | 'PUBLIC_URL'): URL | null => {
    const value = env[name];
    if (!value) {
      problems.push(`${name} must be set when PAPERWORK_ROLE is ${role}.`);
      return null;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${name} (${value}) is not an absolute address.`);
      return null;
    }
    if (url.protocol === 'https:' || (!production && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) return url;
    problems.push(`${name} (${value}) must be an https address.`);
    return null;
  };
  const appUrl = address('APP_URL');
  const publicUrl = address('PUBLIC_URL');
  if (appUrl && publicUrl && appUrl.origin === publicUrl.origin) problems.push('APP_URL and PUBLIC_URL must be the addresses of two different services.');

  const allowed = list(env.ALLOWED_EMAILS);
  if (!allowed.length) problems.push('ALLOWED_EMAILS must name the accounts that may use Paperwork.');
  const relay = (env.CRON_RELAY_ACCOUNT ?? '').trim().toLowerCase();
  if (!relay) problems.push('CRON_RELAY_ACCOUNT must name the edge’s service account.');
  else if (!relay.endsWith('.iam.gserviceaccount.com')) problems.push(`CRON_RELAY_ACCOUNT (${relay}) must be a service account (…iam.gserviceaccount.com).`);
  else if (allowed.includes(relay)) problems.push('CRON_RELAY_ACCOUNT must not be in ALLOWED_EMAILS: the scheduled run’s identity may not use the app.');

  // Finance's read-only feed (finance.ts) is served by the app, behind IAP, to Finance's own service account only:
  // never the owner's account, never the scheduled run's, and never on the public edge
  const finance = (env.FINANCE_READER_ACCOUNT ?? '').trim().toLowerCase();
  if (finance && role === 'edge') problems.push('FINANCE_READER_ACCOUNT must not be set on the edge: Finance’s feed is served by the app, behind IAP.');
  else if (finance) {
    if (!SERVICE_ACCOUNT.test(finance)) problems.push(`FINANCE_READER_ACCOUNT (${finance}) must be one service account (…iam.gserviceaccount.com).`);
    if (allowed.includes(finance)) problems.push('FINANCE_READER_ACCOUNT must not be in ALLOWED_EMAILS: Finance’s identity may only read the feed, not use the app.');
    if (finance === relay) problems.push('FINANCE_READER_ACCOUNT must not be CRON_RELAY_ACCOUNT: the scheduled run’s identity may not read the feed.');
  }

  if (role === 'app') {
    const audience = env.IAP_AUDIENCE ?? '';
    if (!IAP_AUDIENCE.test(audience)) problems.push(`IAP_AUDIENCE (${audience || 'unset'}) must look like /projects/NUMBER/locations/REGION/services/SERVICE.`);
    else if (env.K_SERVICE && !audience.endsWith(`/services/${env.K_SERVICE}`)) problems.push(`IAP_AUDIENCE (${audience}) is not for this service (${env.K_SERVICE}).`);
  }

  if (role === 'edge') {
    if (!env.CRON_SERVICE_ACCOUNT) problems.push('CRON_SERVICE_ACCOUNT must name Cloud Scheduler’s service account.');
    if (!env.CRON_AUDIENCE) problems.push('CRON_AUDIENCE must be set to the address Cloud Scheduler calls (PUBLIC_URL).');
    else if (env.APP_URL && env.CRON_AUDIENCE.replace(/\/+$/, '') === env.APP_URL.replace(/\/+$/, '')) {
      problems.push('CRON_AUDIENCE must be the edge’s address (PUBLIC_URL), not APP_URL: Cloud Scheduler calls the edge.');
    }
  }

  // Tripwire for swapped settings on Cloud Run: each service must carry its own address, which is
  // <service>-<project number>.<region>.run.app (a prefix alone won't do: "paperwork-app-…" starts with "paperwork-")
  const own = role === 'app' ? appUrl : publicUrl;
  const label = own?.hostname.split('.')[0] ?? '';
  if (env.K_SERVICE && own && own.hostname.endsWith('.run.app') && !(label.startsWith(`${env.K_SERVICE}-`) && /^\d+$/.test(label.slice(env.K_SERVICE.length + 1)))) {
    problems.push(`${role === 'app' ? 'APP_URL' : 'PUBLIC_URL'} (${own.origin}) is not this service’s address (${env.K_SERVICE}); are the app’s and the edge’s settings swapped?`);
  }
  return problems;
}
