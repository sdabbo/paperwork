// Settings checked at start-up, how production is recognised, and what only the app may do.
import { afterEach, describe, expect, it } from 'vitest';
import { config } from './config.js';
import { FilerOnly, assertFiler, configProblems } from './roles.js';

const SECRET = 'x'.repeat(40);
const APP = 'https://paperwork-app-123456789012.europe-west3.run.app';
const EDGE = 'https://paperwork-123456789012.europe-west3.run.app';
const RELAY = 'paperwork-edge@example-project.iam.gserviceaccount.com';

const appEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  K_SERVICE: 'paperwork-app',
  APP_SECRET: SECRET,
  PAPERWORK_ROLE: 'app',
  APP_URL: APP,
  PUBLIC_URL: EDGE,
  ALLOWED_EMAILS: 'owner@example.com',
  CRON_RELAY_ACCOUNT: RELAY,
  IAP_AUDIENCE: '/projects/123456789012/locations/europe-west3/services/paperwork-app',
  ...extra,
});

const edgeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  K_SERVICE: 'paperwork',
  APP_SECRET: SECRET,
  PAPERWORK_ROLE: 'edge',
  APP_URL: APP,
  PUBLIC_URL: EDGE,
  ALLOWED_EMAILS: 'owner@example.com',
  CRON_RELAY_ACCOUNT: RELAY,
  CRON_SERVICE_ACCOUNT: 'paperwork-scheduler@example-project.iam.gserviceaccount.com',
  CRON_AUDIENCE: EDGE,
  ...extra,
});

const saved = { ...process.env };

afterEach(() => {
  for (const key of ['PAPERWORK_ROLE', 'K_SERVICE', 'NODE_ENV', 'APP_URL', 'PUBLIC_URL']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('the settings checked at start-up', () => {
  it('pass for one service as today, and for a valid app and edge', () => {
    expect(configProblems({ NODE_ENV: 'test' })).toEqual([]);
    expect(configProblems({ NODE_ENV: 'production', APP_SECRET: SECRET, PAPERWORK_ROLE: 'all' })).toEqual([]);
    expect(configProblems(appEnv())).toEqual([]);
    expect(configProblems(edgeEnv())).toEqual([]);
    // Locally, both on this computer
    expect(configProblems(appEnv({ NODE_ENV: 'development', K_SERVICE: undefined, APP_URL: 'http://localhost:3000', PUBLIC_URL: 'http://localhost:3001' }))).toEqual([]);
  });

  const problemsOf = (env: NodeJS.ProcessEnv) => configProblems(env).join('\n');

  it('refuse an unknown role', () => {
    expect(problemsOf({ PAPERWORK_ROLE: 'both' })).toContain('PAPERWORK_ROLE is "both"');
  });

  it('want two absolute https addresses of different services', () => {
    expect(problemsOf(appEnv({ APP_URL: undefined }))).toContain('APP_URL must be set');
    expect(problemsOf(edgeEnv({ PUBLIC_URL: '' }))).toContain('PUBLIC_URL must be set');
    expect(problemsOf(appEnv({ PUBLIC_URL: 'paperwork.example' }))).toContain('PUBLIC_URL (paperwork.example) is not an absolute address');
    expect(problemsOf(appEnv({ PUBLIC_URL: 'http://paperwork-123456789012.europe-west3.run.app' }))).toContain('must be an https address');
    // Plain http only on this computer, and not in production
    expect(problemsOf(appEnv({ K_SERVICE: undefined, APP_URL: 'http://localhost:3000' }))).toContain('APP_URL (http://localhost:3000) must be an https address');
    expect(problemsOf(edgeEnv({ PUBLIC_URL: `${APP}/` }))).toContain('two different services');
  });

  it('want the accounts that may use Paperwork, and a relay account that is a service account and not one of them', () => {
    expect(problemsOf(appEnv({ ALLOWED_EMAILS: '' }))).toContain('ALLOWED_EMAILS must name');
    expect(problemsOf(edgeEnv({ CRON_RELAY_ACCOUNT: undefined }))).toContain('CRON_RELAY_ACCOUNT must name');
    expect(problemsOf(appEnv({ CRON_RELAY_ACCOUNT: 'owner@example.com' }))).toContain('must be a service account');
    expect(problemsOf(appEnv({ ALLOWED_EMAILS: `owner@example.com, ${RELAY.toUpperCase()}` }))).toContain('must not be in ALLOWED_EMAILS');
  });

  it('want the app’s IAP audience, for this service', () => {
    expect(problemsOf(appEnv({ IAP_AUDIENCE: undefined }))).toContain('IAP_AUDIENCE (unset) must look like');
    expect(problemsOf(appEnv({ IAP_AUDIENCE: '123456789012' }))).toContain('must look like');
    expect(problemsOf(appEnv({ IAP_AUDIENCE: '/projects/123456789012/locations/europe-west3/services/paperwork' }))).toContain('is not for this service (paperwork-app)');
  });

  it('want the edge’s Scheduler account and audience, and not the app’s address as the audience', () => {
    expect(problemsOf(edgeEnv({ CRON_SERVICE_ACCOUNT: undefined }))).toContain('CRON_SERVICE_ACCOUNT must name');
    expect(problemsOf(edgeEnv({ CRON_AUDIENCE: undefined }))).toContain('CRON_AUDIENCE must be set');
    expect(problemsOf(edgeEnv({ CRON_AUDIENCE: `${APP}/` }))).toContain('not APP_URL');
  });

  it('notice the app’s and the edge’s settings swapped on Cloud Run', () => {
    expect(problemsOf(appEnv({ K_SERVICE: 'paperwork', IAP_AUDIENCE: '/projects/123456789012/locations/europe-west3/services/paperwork' }))).toContain('are the app’s and the edge’s settings swapped?');
    expect(problemsOf(edgeEnv({ K_SERVICE: 'paperwork-app' }))).toContain('PUBLIC_URL (https://paperwork-123456789012.europe-west3.run.app) is not this service’s address');
  });

  describe('Finance’s account for the read-only feed', () => {
    const FINANCE = 'finance-server@example-project.iam.gserviceaccount.com';

    it('passes on the app as one service account, and is not needed', () => {
      expect(configProblems(appEnv({ FINANCE_READER_ACCOUNT: FINANCE }))).toEqual([]);
      expect(configProblems(appEnv({ FINANCE_READER_ACCOUNT: `  ${FINANCE.toUpperCase()} ` }))).toEqual([]);
      expect(configProblems(appEnv({ FINANCE_READER_ACCOUNT: '' }))).toEqual([]);
    });

    it('is refused on the edge, which never serves the feed', () => {
      expect(problemsOf(edgeEnv({ FINANCE_READER_ACCOUNT: FINANCE }))).toContain('FINANCE_READER_ACCOUNT must not be set on the edge');
    });

    it('must be a service account', () => {
      expect(problemsOf(appEnv({ FINANCE_READER_ACCOUNT: 'owner@gmail.com' }))).toContain('must be one service account');
      expect(problemsOf(appEnv({ FINANCE_READER_ACCOUNT: 'finance-server@example-project.iam.gserviceaccount.com.evil.example' }))).toContain('must be one service account');
    });

    it('must be exactly one, not a list that also ends like one', () => {
      expect(problemsOf(appEnv({ FINANCE_READER_ACCOUNT: `${FINANCE},other@example-project.iam.gserviceaccount.com` }))).toContain('must be one service account');
      expect(problemsOf(appEnv({ FINANCE_READER_ACCOUNT: `${FINANCE} other@example-project.iam.gserviceaccount.com` }))).toContain('must be one service account');
    });

    it('must not be one of the accounts that may use the app', () => {
      expect(problemsOf(appEnv({ FINANCE_READER_ACCOUNT: FINANCE, ALLOWED_EMAILS: `owner@example.com,${FINANCE.toUpperCase()}` }))).toContain('FINANCE_READER_ACCOUNT must not be in ALLOWED_EMAILS');
    });

    it('must not be the scheduled run’s account', () => {
      expect(problemsOf(appEnv({ FINANCE_READER_ACCOUNT: RELAY }))).toContain('FINANCE_READER_ACCOUNT must not be CRON_RELAY_ACCOUNT');
    });

    it('is ignored as one service, which has no IAP to let Finance in (app.ts answers 404 there)', () => {
      expect(configProblems({ NODE_ENV: 'production', APP_SECRET: SECRET, FINANCE_READER_ACCOUNT: 'anything' })).toEqual([]);
    });
  });

  it('want a real APP_SECRET in production, whatever the role', () => {
    expect(problemsOf({ NODE_ENV: 'production' })).toContain('APP_SECRET must be set');
    expect(problemsOf({ K_SERVICE: 'paperwork', APP_SECRET: 'short' })).toContain('APP_SECRET must be set');
    expect(problemsOf(edgeEnv({ APP_SECRET: undefined }))).toContain('APP_SECRET must be set');
  });
});

describe('Finance’s account as the app reads it', () => {
  it('is trimmed and in lower case, as IAP signs addresses; empty when unset', () => {
    const saved = process.env.FINANCE_READER_ACCOUNT;
    try {
      process.env.FINANCE_READER_ACCOUNT = '  Finance-Server@example-project.IAM.gserviceaccount.com ';
      expect(config.financeReaderAccount).toBe('finance-server@example-project.iam.gserviceaccount.com');
      delete process.env.FINANCE_READER_ACCOUNT;
      expect(config.financeReaderAccount).toBe('');
    } finally {
      if (saved === undefined) delete process.env.FINANCE_READER_ACCOUNT;
      else process.env.FINANCE_READER_ACCOUNT = saved;
    }
  });
});

describe('production', () => {
  it('is recognised on Cloud Run even without NODE_ENV', () => {
    delete process.env.NODE_ENV;
    delete process.env.K_SERVICE;
    expect(config.isProduction).toBe(false);
    process.env.K_SERVICE = 'paperwork';
    expect(config.isProduction).toBe(true);
  });
});

describe('the role', () => {
  it('is all unless set, and the public address is the app’s unless set', () => {
    delete process.env.PAPERWORK_ROLE;
    delete process.env.PUBLIC_URL;
    process.env.APP_URL = 'https://app.example/';
    expect(config.role).toBe('all');
    expect(config.publicUrl).toBe('https://app.example');
    process.env.PUBLIC_URL = 'https://edge.example//';
    expect(config.publicUrl).toBe('https://edge.example');
    process.env.PAPERWORK_ROLE = 'edge';
    expect(config.role).toBe('edge');
    process.env.PAPERWORK_ROLE = 'both';
    expect(() => config.role).toThrow('PAPERWORK_ROLE must be');
  });

  it('keeps filing to the app', () => {
    delete process.env.PAPERWORK_ROLE;
    expect(() => assertFiler('Filing')).not.toThrow();
    process.env.PAPERWORK_ROLE = 'app';
    expect(() => assertFiler('Filing')).not.toThrow();
    process.env.PAPERWORK_ROLE = 'edge';
    expect(() => assertFiler('Filing')).toThrow(FilerOnly);
  });
});
