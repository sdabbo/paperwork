// The deploy scripts (deploy/deploy.sh, deploy/guard.sh, deploy/protect.sh isolate and finance) against a fake gcloud
// that logs every call and answers from canned service descriptions: as one service a deploy is exactly what it was
// before deploy/protect.sh existed; it becomes two services only when configuration says so; the check after a deploy
// passes quietly as one service; isolate limits Paperwork's accounts to its own database, giving the access back when
// Paperwork can't read its database then; finance lets a finance app's account read the feed, and only once it is seen
// to reach nothing else, taking back what it changed when the test call fails; and github-settings.sh sets the
// repository's protections. Nothing here reaches Google or GitHub.
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROJECT = 'example-project';
const NUMBER = '123456789012';
const SERVICE_URL = `https://paperwork-${NUMBER}.europe-west3.run.app`;
const APP_URL = `https://paperwork-app-${NUMBER}.europe-west3.run.app`;
const RUN_SA = `paperwork-server@${PROJECT}.iam.gserviceaccount.com`;
const EDGE_SA = `paperwork-edge@${PROJECT}.iam.gserviceaccount.com`;
const IMAGE = `europe-west3-docker.pkg.dev/${PROJECT}/paperwork/paperwork:abc123`;
const DIGEST = `europe-west3-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/paperwork-app@sha256:${'1'.repeat(64)}`;
const SECRETS =
  'GEMINI_API_KEY=paperwork-gemini-api-key:latest,GOOGLE_CLIENT_SECRET=paperwork-google-client-secret:latest,APP_SECRET=paperwork-app-secret:latest,INBOUND_EMAIL_SECRET=paperwork-inbound-email-secret:latest';
const SPLIT_LINES = `GCP_APP_SERVICE=paperwork-app\nGCP_EDGE_SERVICE_ACCOUNT=${EDGE_SA}\n`;

// gcloud: each call's argv on a line (separated by \x1f); services from $FAKE_STATE/service-<name>.json; env files
// kept per service
const FAKE_GCLOUD = `#!/usr/bin/env bash
(IFS=$'\\x1f'; echo "$*") >>"$FAKE_STATE/calls"
case "$*" in
  "run services describe "*"value(status.latestReadyRevisionName)"*) [ -f "$FAKE_STATE/service-$4.json" ] && echo "$4-00042-abc" ;;
  "run revisions describe "*"value(status.imageDigest)"*) echo "${DIGEST}" ;;
  "run services describe "*)
    if [ -n "$FAKE_DESCRIBE_FAILS" ] || [ "$FAKE_DESCRIBE_FAILS_FOR" = "$4" ]; then echo "ERROR: (gcloud.run.services.describe) There was a problem refreshing your current auth tokens" >&2; exit 1; fi
    if [ -f "$FAKE_STATE/service-$4.json" ]; then cat "$FAKE_STATE/service-$4.json"; else echo "ERROR: (gcloud.run.services.describe) Cannot find service [$4]" >&2; exit 1; fi ;;
  "run deploy "*)
    next=""
    for a in "$@"; do
      if [ -n "$next" ]; then cp "$a" "$FAKE_STATE/env-$3.yaml"; next=""; fi
      if [ "$a" = --env-vars-file ]; then next=1; fi
    done ;;
  "artifacts repositories describe"*) exit 1 ;;
  "projects describe "*"value(projectNumber)"*) echo ${NUMBER} ;;
  "config get-value account"*) echo owner@example.com ;;
  "iap web get-iam-policy "*) [ -f "$FAKE_STATE/iap-policy.json" ] && cat "$FAKE_STATE/iap-policy.json" || exit 1 ;;
  *) ;;
esac
`;

interface Service {
  account?: string;
  env: Record<string, string>;
  annotations?: Record<string, string>;
  image?: string;
}
const described = (s: Service) =>
  JSON.stringify({
    metadata: { annotations: s.annotations ?? {} },
    spec: { template: { spec: { serviceAccountName: s.account ?? RUN_SA, containers: [{ image: s.image, env: Object.entries(s.env).map(([name, value]) => ({ name, value })) }] } } },
  });

// What runs today: one service on (default)
const ONE: Service = {
  env: { NODE_ENV: 'production', FIRESTORE_DB: '(default)', ALLOWED_EMAILS: 'owner@example.com', GOOGLE_CLIENT_ID: `${NUMBER}-abc.apps.googleusercontent.com`, PICKER_API_KEY: 'AIza-picker', APP_LANGUAGE: 'de' },
};
// After protect.sh split
const EDGE: Service = {
  account: EDGE_SA,
  env: { ...ONE.env, PAPERWORK_ROLE: 'edge', APP_URL, PUBLIC_URL: SERVICE_URL },
};
const APP: Service = {
  annotations: { 'run.googleapis.com/iap-enabled': 'true' },
  env: { ...ONE.env, PAPERWORK_ROLE: 'app', IAP_AUDIENCE: `/projects/${NUMBER}/locations/europe-west3/services/paperwork-app` },
};

let tmp: string;
let bin: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperwork-deploy-'));
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gcloud'), FAKE_GCLOUD, { mode: 0o755 });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let runs = 0;
// deploy/github-deploy.env as setup.sh writes it: without the lines protect.sh split adds, which each test sets itself
const DEPLOY_ENV = `# Where GitHub Actions deploys Paperwork
GCP_PROJECT_ID=${PROJECT}
GCP_PROJECT_NUMBER=${NUMBER}
GCP_REGION=europe-west3
GCP_WORKLOAD_IDENTITY_PROVIDER=projects/${NUMBER}/locations/global/workloadIdentityPools/github-actions/providers/paperwork
GCP_DEPLOY_SERVICE_ACCOUNT=paperwork-deployer@${PROJECT}.iam.gserviceaccount.com
`;
function copyDeployEnv(dir: string) {
  fs.writeFileSync(path.join(dir, 'deploy', 'github-deploy.env'), DEPLOY_ENV);
}

// Runs a script of a copy of deploy/ with only the given environment (never the test runner's CI variables), and
// the given .env
async function script(name: 'deploy.sh' | 'guard.sh', services: Record<string, Service>, env: Record<string, string> = {}, deployEnv = '', dotEnv = '', files: Record<string, string> = {}) {
  const dir = path.join(tmp, `run-${++runs}`);
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true });
  fs.mkdirSync(state);
  if (dotEnv) fs.writeFileSync(path.join(dir, '.env'), dotEnv);
  for (const file of ['config.sh', 'deploy.sh', 'guard.sh', 'image-cleanup.json']) fs.copyFileSync(path.join(ROOT, 'deploy', file), path.join(dir, 'deploy', file));
  copyDeployEnv(dir);
  fs.appendFileSync(path.join(dir, 'deploy', 'github-deploy.env'), deployEnv);
  for (const [service, s] of Object.entries(services)) fs.writeFileSync(path.join(state, `service-${service}.json`), described(s));
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(state, file), text);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
    execFile('bash', [path.join('deploy', name)], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, FAKE_STATE: state, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    )
  );
  const read = (file: string) => (fs.existsSync(path.join(state, file)) ? fs.readFileSync(path.join(state, file), 'utf8') : '');
  const calls = read('calls')
    .split('\n')
    .filter(Boolean)
    // The env file is a temporary file with a new name each time
    .map(line => line.split('\x1f').map((arg, i, args) => (args[i - 1] === '--env-vars-file' ? 'ENVFILE' : arg)));
  return { ...result, calls, deploys: calls.filter(c => c[0] === 'run' && c[1] === 'deploy'), envOf: (service: string) => read(`env-${service}.yaml`) };
}

const CI = { CI: '1', IMAGE, PROJECT_NUMBER: NUMBER };
const deployArgs = (service: string, source: string[], access: string[], account: string) => [
  'run', 'deploy', service, ...source, '--region', 'europe-west3', '--project', PROJECT, '--quiet', ...access,
  '--service-account', account, '--min-instances', '0', '--max-instances', '1', '--cpu-throttling', '--cpu', '1', '--memory', '1Gi', '--timeout', '600',
  '--env-vars-file', 'ENVFILE', '--set-secrets', SECRETS,
];

// Each run has its own copy of the scripts and its own state, so they run side by side. A run starts bash, gcloud and
// node a few dozen times, which takes seconds while the other test files run too.
const SLOW = { timeout: 60_000 };

describe.concurrent('deploy.sh as one service (nothing written by protect.sh)', SLOW, () => {
  it('deploys from GitHub exactly as before: the same gcloud calls and settings', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: ONE }, CI);
    expect(run.code).toBe(0);
    expect(run.calls).toEqual([
      ['run', 'services', 'describe', 'paperwork', '--region', 'europe-west3', '--project', PROJECT, '--format=json'],
      deployArgs('paperwork', ['--image', IMAGE], [], RUN_SA),
    ]);
    expect(run.envOf('paperwork')).toBe(
      [
        'NODE_ENV: production',
        'STORAGE: firestore',
        `GOOGLE_CLOUD_PROJECT: "${PROJECT}"`,
        'FIRESTORE_DB: "(default)"',
        'TZ: "Europe/Berlin"',
        `APP_URL: "${SERVICE_URL}"`,
        'ALLOWED_EMAILS: "owner@example.com"',
        `GOOGLE_CLIENT_ID: "${NUMBER}-abc.apps.googleusercontent.com"`,
        `CRON_SERVICE_ACCOUNT: "paperwork-scheduler@${PROJECT}.iam.gserviceaccount.com"`,
        `CRON_AUDIENCE: "${SERVICE_URL}"`,
        'PICKER_API_KEY: "AIza-picker"',
        'APP_LANGUAGE: "de"',
        '',
      ].join('\n')
    );
  });

  it('deploys from your machine as before: built from source, public', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: ONE });
    expect(run.code).toBe(0);
    expect(run.deploys).toEqual([deployArgs('paperwork', ['--source', '.'], ['--allow-unauthenticated'], RUN_SA)]);
    expect(run.envOf('paperwork')).not.toContain('PAPERWORK_ROLE');
  });

  it('refuses DEPLOY_ONLY', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: ONE }, { DEPLOY_ONLY: 'app' });
    expect(run.code).toBe(1);
    expect(run.deploys).toEqual([]);
  });

  it('makes a new public service only when gcloud says there is none, never when reading it fails', async ({ expect }) => {
    const settings = { ALLOWED_EMAILS: 'owner@example.com', GOOGLE_CLIENT_ID: `${NUMBER}-abc.apps.googleusercontent.com`, PICKER_API_KEY: 'AIza-picker' };
    const first = await script('deploy.sh', {}, settings);
    expect(first.code).toBe(0);
    expect(first.deploys).toEqual([deployArgs('paperwork', ['--source', '.'], ['--allow-unauthenticated'], RUN_SA)]);
    // The edge, read at a bad moment: not taken for no service, which would make it the whole app, public
    const failing = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, { ...settings, FAKE_DESCRIBE_FAILS: '1' });
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("Couldn't read the Cloud Run service paperwork");
    expect(failing.deploys).toEqual([]);
  });
});

describe.concurrent('deploy.sh as two services', SLOW, () => {
  it('deploys the app, then the edge, from GitHub without touching IAP or who may call them', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, CI, SPLIT_LINES);
    expect(run.code).toBe(0);
    expect(run.deploys).toEqual([deployArgs('paperwork-app', ['--image', IMAGE], [], RUN_SA), deployArgs('paperwork', ['--image', IMAGE], [], EDGE_SA)]);
    const app = run.envOf('paperwork-app');
    expect(app).toContain('FIRESTORE_DB: "(default)"\n');
    expect(app).toContain(`APP_URL: "${APP_URL}"\n`);
    expect(app).toContain('PAPERWORK_ROLE: app\n');
    expect(app).toContain(`PUBLIC_URL: "${SERVICE_URL}"\n`);
    expect(app).toContain(`CRON_RELAY_ACCOUNT: "${EDGE_SA}"\n`);
    expect(app).toContain(`IAP_AUDIENCE: "/projects/${NUMBER}/locations/europe-west3/services/paperwork-app"\n`);
    expect(app).not.toContain('CRON_AUDIENCE');
    const edge = run.envOf('paperwork');
    expect(edge).toContain('FIRESTORE_DB: "(default)"\n');
    expect(edge).toContain(`APP_URL: "${APP_URL}"\n`);
    expect(edge).toContain('PAPERWORK_ROLE: edge\n');
    expect(edge).toContain(`PUBLIC_URL: "${SERVICE_URL}"\n`);
    expect(edge).toContain(`CRON_AUDIENCE: "${SERVICE_URL}"\n`);
    expect(edge).toContain(`CRON_RELAY_ACCOUNT: "${EDGE_SA}"\n`);
    expect(edge).not.toContain('IAP_AUDIENCE');
  });

  it('from your machine: IAP on and nobody else for the app, the edge public with the app’s new image', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, {}, SPLIT_LINES);
    expect(run.code).toBe(0);
    expect(run.deploys).toEqual([
      deployArgs('paperwork-app', ['--source', '.'], ['--iap', '--no-allow-unauthenticated'], RUN_SA),
      deployArgs('paperwork', ['--image', DIGEST], ['--allow-unauthenticated'], EDGE_SA),
    ]);
  });

  it('keeps the audiences the running services have, whatever .env says', async ({ expect }) => {
    const corrected = `/projects/${NUMBER}/locations/europe-west3/services/paperwork-app-corrected`;
    const services = { paperwork: { ...EDGE, env: { ...EDGE.env, CRON_RELAY_AUDIENCE: `${APP_URL}/*` } }, 'paperwork-app': { ...APP, env: { ...APP.env, IAP_AUDIENCE: corrected } } };
    // As for trying the two roles locally
    const dotEnv = 'IAP_AUDIENCE=/projects/1/locations/local/services/paperwork-app\nCRON_RELAY_AUDIENCE=http://localhost:3001/internal/cron\n';
    const run = await script('deploy.sh', services, {}, SPLIT_LINES, dotEnv);
    expect(run.code).toBe(0);
    expect(run.envOf('paperwork-app')).toContain(`IAP_AUDIENCE: "${corrected}"\n`);
    expect(run.envOf('paperwork')).toContain(`CRON_RELAY_AUDIENCE: "${APP_URL}/*"\n`);
    // The environment still decides (protect.sh gives the edge's that way)
    const given = await script('deploy.sh', services, { DEPLOY_ONLY: 'edge', CRON_RELAY_AUDIENCE: `${APP_URL}/internal/cron` }, SPLIT_LINES, dotEnv);
    expect(given.envOf('paperwork')).toContain(`CRON_RELAY_AUDIENCE: "${APP_URL}/internal/cron"\n`);
  });

  it('deploys nothing from your machine when the app can’t be read, rather than its settings falling back to defaults', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, { FAKE_DESCRIBE_FAILS_FOR: 'paperwork-app' }, SPLIT_LINES);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Couldn't read the Cloud Run service paperwork-app");
    expect(run.deploys).toEqual([]);
  });

  it('deploys only the edge with DEPLOY_ONLY=edge', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, { DEPLOY_ONLY: 'edge' }, SPLIT_LINES);
    expect(run.code).toBe(0);
    expect(run.deploys).toEqual([deployArgs('paperwork', ['--image', DIGEST], ['--allow-unauthenticated'], EDGE_SA)]);
  });

  it('stays two services when the lines are lost but the running service is the edge, with a warning', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, { ...CI, GITHUB_ACTIONS: 'true' });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('::warning::');
    expect(run.deploys.map(d => [d[2], d[d.indexOf('--service-account') + 1]])).toEqual([
      ['paperwork-app', RUN_SA],
      ['paperwork', EDGE_SA],
    ]);
  });

  it('goes back to one service with PAPERWORK_SPLIT=off from your machine, and refuses it from GitHub', async ({ expect }) => {
    const back = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, { PAPERWORK_SPLIT: 'off' }, SPLIT_LINES);
    expect(back.code).toBe(0);
    expect(back.deploys).toEqual([deployArgs('paperwork', ['--source', '.'], ['--allow-unauthenticated'], RUN_SA)]);
    expect(back.envOf('paperwork')).not.toContain('PAPERWORK_ROLE');
    const ci = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, { ...CI, PAPERWORK_SPLIT: 'off' }, SPLIT_LINES);
    expect(ci.code).toBe(1);
    expect(ci.deploys).toEqual([]);
  });

  it('refuses to deploy from GitHub before the app exists', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: ONE }, CI, SPLIT_LINES);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Run deploy/protect.sh split first');
    expect(run.deploys).toEqual([]);
  });
});

// Finance's read-only feed is switched on by FINANCE_READER_ACCOUNT on the app (protect.sh finance): every later deploy
// keeps it, only the app gets it, and it never comes from .env
const FINANCE = `finance-server@${PROJECT}.iam.gserviceaccount.com`;
const APP_WITH_FEED: Service = { ...APP, image: IMAGE, env: { ...APP.env, FINANCE_READER_ACCOUNT: FINANCE } };

describe.concurrent('deploy.sh and Finance’s feed', SLOW, () => {
  it('from GitHub, keeps the account the running app has, in the app’s settings only', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP_WITH_FEED }, CI, SPLIT_LINES);
    expect(run.code).toBe(0);
    expect(run.envOf('paperwork-app')).toContain(`FINANCE_READER_ACCOUNT: "${FINANCE}"\n`);
    expect(run.envOf('paperwork')).not.toContain('FINANCE_READER_ACCOUNT');
    // Off stays off
    const off = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, CI, SPLIT_LINES);
    expect(off.envOf('paperwork-app')).not.toContain('FINANCE_READER_ACCOUNT');
  });

  it('as protect.sh finance switches it on: from the environment, only the app, with the image it runs', async ({ expect }) => {
    const services = { paperwork: EDGE, 'paperwork-app': { ...APP, env: { ...APP.env, FINANCE_READER_ACCOUNT: `old-finance@${PROJECT}.iam.gserviceaccount.com` } } };
    const run = await script('deploy.sh', services, { DEPLOY_ONLY: 'app', APP_SERVICE: 'paperwork-app', EDGE_SA, IMAGE, FINANCE_READER_ACCOUNT: FINANCE });
    expect(run.code).toBe(0);
    expect(run.deploys).toEqual([deployArgs('paperwork-app', ['--image', IMAGE], ['--iap', '--no-allow-unauthenticated'], RUN_SA)]);
    expect(run.envOf('paperwork-app')).toContain(`FINANCE_READER_ACCOUNT: "${FINANCE}"\n`);
    expect(run.envOf('paperwork-app')).toContain('PAPERWORK_ROLE: app\n');
  });

  it('never from .env, which may hold what runs locally', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: EDGE, 'paperwork-app': APP }, {}, SPLIT_LINES, `FINANCE_READER_ACCOUNT=${FINANCE}\n`);
    expect(run.code).toBe(0);
    expect(run.envOf('paperwork-app')).not.toContain('FINANCE_READER_ACCOUNT');
    expect(run.envOf('paperwork')).not.toContain('FINANCE_READER_ACCOUNT');
  });

  it('never as one service, which has no IAP to let Finance in', async ({ expect }) => {
    const run = await script('deploy.sh', { paperwork: { ...ONE, env: { ...ONE.env, FINANCE_READER_ACCOUNT: FINANCE } } }, { ...CI, FINANCE_READER_ACCOUNT: FINANCE });
    expect(run.code).toBe(0);
    expect(run.envOf('paperwork')).not.toContain('FINANCE_READER_ACCOUNT');
  });
});

describe('guard.sh', SLOW, () => {
  it('passes with a notice as one service, asking nothing of the addresses', async ({ expect }) => {
    const run = await script('guard.sh', { paperwork: ONE }, { GITHUB_ACTIONS: 'true', PROJECT_NUMBER: NUMBER });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('::notice::Paperwork runs as one service');
    expect(run.stdout).not.toContain('::warning::');
    expect(run.calls).toEqual([
      ['run', 'services', 'describe', 'paperwork', '--region', 'europe-west3', '--project', PROJECT, '--format=json'],
      ['run', 'services', 'describe', 'paperwork-app', '--region', 'europe-west3', '--project', PROJECT, '--format=json'],
    ]);
  });

  it('fails, rather than passing as one service, when it can’t read the service', async ({ expect }) => {
    const run = await script('guard.sh', { paperwork: EDGE, 'paperwork-app': APP }, { GITHUB_ACTIONS: 'true', PROJECT_NUMBER: NUMBER, FAKE_DESCRIBE_FAILS: '1' });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Couldn't read the Cloud Run service paperwork");
  });

  it('warns as one service when the app still runs behind IAP: paperwork is the whole app again', async ({ expect }) => {
    const run = await script('guard.sh', { paperwork: ONE, 'paperwork-app': APP }, { GITHUB_ACTIONS: 'true', PROJECT_NUMBER: NUMBER });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('::warning::paperwork-app runs as Paperwork');
  });

  // The two services' addresses, answering as they should, but for the edge's token endpoint
  async function doors(tokenStatus: number) {
    const listen = (handler: http.RequestListener) =>
      new Promise<{ server: http.Server; url: string }>(resolve => {
        const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
      });
    const app = await listen((req, res) => {
      if (req.headers['x-requested-with']) return res.writeHead(401).end();
      res.writeHead(302, { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=iap' }).end();
    });
    const edge: { server: http.Server; url: string } = await listen((req, res) => {
      const url = new URL(req.url!, edge.url);
      const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /oauth/authorize') return res.writeHead(302, { location: `${app.url}/oauth/authorize${url.search}` }).end();
      if (route === 'GET /.well-known/oauth-authorization-server') return json({ issuer: edge.url, token_endpoint: `${edge.url}/oauth/token` });
      if (route === 'GET /.well-known/oauth-protected-resource/mcp') return json({ resource: `${edge.url}/mcp` });
      if (route === 'POST /mcp') return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${edge.url}/.well-known/oauth-protected-resource/mcp"` }).end();
      if (route === 'POST /inbound/email') return res.writeHead(401).end();
      if (route === 'POST /internal/cron') return res.writeHead(403).end();
      if (route === 'POST /oauth/token') return res.writeHead(tokenStatus, { 'content-type': 'application/json' }).end('{}');
      if (route === 'GET /health') return res.writeHead(200).end('ok');
      res.writeHead(404).end();
    });
    return { env: { GUARD_APP_URL: app.url, GUARD_EDGE_URL: edge.url, GUARD_WAIT: '0', PROJECT_NUMBER: NUMBER }, close: () => Promise.all([app.server, edge.server].map(s => new Promise(r => s.close(r)))) };
  }

  it('as two services, passes when every door is as it should be, and fails when the edge can’t read its store', async ({ expect }) => {
    const good = await doors(401);
    try {
      const run = await script('guard.sh', { paperwork: EDGE, 'paperwork-app': APP }, good.env, SPLIT_LINES);
      expect(run.stdout).toContain('ok: POST /oauth/token for an app it doesn\'t know: 401 (the edge reads its store)');
      expect(run.code).toBe(0);
    } finally {
      await good.close();
    }
    // Firestore refuses the edge (its access doesn't match Paperwork's database): Gemini and email fail
    const refused = await doors(500);
    try {
      const run = await script('guard.sh', { paperwork: EDGE, 'paperwork-app': APP }, refused.env, SPLIT_LINES);
      expect(run.code).toBe(1);
      expect(run.stdout).toContain('FAILED: POST /oauth/token for an app it doesn\'t know');
      expect(run.stdout).toContain('can\'t read Paperwork\'s Firestore database');
    } finally {
      await refused.close();
    }
  });

  // IAP's policy as protect.sh split and finance leave it: the owner, the edge for the scheduled run, Finance
  const iapPolicy = (...extra: { role: string; members: string[]; condition?: object }[]) =>
    JSON.stringify({
      bindings: [
        { role: 'roles/iap.httpsResourceAccessor', members: ['user:owner@example.com', `serviceAccount:${EDGE_SA}`] },
        { role: 'roles/iap.httpsResourceAccessor', members: [`serviceAccount:${FINANCE}`], condition: { expression: 'request.path.startsWith("/internal/finance/")', title: 'finance-feed-only' } },
        ...extra,
      ],
    });

  it('with the feed on: a stranger is sent to sign-in, the edge answers 404, and IAP lets through only whom it should', async ({ expect }) => {
    const good = await doors(401);
    try {
      const run = await script('guard.sh', { paperwork: EDGE, 'paperwork-app': APP_WITH_FEED }, good.env, SPLIT_LINES, '', { 'iap-policy.json': iapPolicy() });
      expect(run.stdout).toContain(`ok: the feed for Finance is switched on for ${FINANCE}`);
      expect(run.stdout).toContain('ok: GET /internal/finance/contracts sends a stranger to Google sign-in');
      expect(run.stdout).toContain('ok: GET /internal/finance/contracts: 404 on the edge');
      expect(run.stdout).toContain('ok: doesn\'t carry FINANCE_READER_ACCOUNT');
      expect(run.stdout).toContain('ok: IAP lets through only the app\'s ALLOWED_EMAILS, the edge\'s account and Finance\'s');
      expect(run.code).toBe(0);
      expect(run.calls).toContainEqual(['iap', 'web', 'get-iam-policy', '--resource-type=cloud-run', '--service=paperwork-app', '--region=europe-west3', '--project', PROJECT, '--format=json']);
    } finally {
      await good.close();
    }
  });

  it('fails when the edge carries Finance’s account, or IAP lets Finance through while the feed is off', async ({ expect }) => {
    const good = await doors(401);
    try {
      const edge = await script('guard.sh', { paperwork: { ...EDGE, env: { ...EDGE.env, FINANCE_READER_ACCOUNT: FINANCE } }, 'paperwork-app': APP_WITH_FEED }, good.env, SPLIT_LINES, '', { 'iap-policy.json': iapPolicy() });
      expect(edge.code).toBe(1);
      expect(edge.stdout).toContain('FAILED: paperwork carries FINANCE_READER_ACCOUNT');
      const off = await script('guard.sh', { paperwork: EDGE, 'paperwork-app': APP }, good.env, SPLIT_LINES, '', { 'iap-policy.json': iapPolicy() });
      expect(off.stdout).toContain('ok: the feed for Finance is off');
      expect(off.code).toBe(1);
      expect(off.stdout).toContain(`FAILED: IAP lets through more than it should to paperwork-app: serviceAccount:${FINANCE} (roles/iap.httpsResourceAccessor)`);
    } finally {
      await good.close();
    }
  });

  it('fails on anyone else IAP lets through, and only warns in GitHub Actions, whose account may not read that', async ({ expect }) => {
    const good = await doors(401);
    try {
      const extras = [
        { role: 'roles/iap.httpsResourceAccessor', members: ['allUsers'] },
        { role: 'roles/iap.httpsResourceAccessor', members: ['domain:example.com'] },
        { role: 'roles/iap.httpsResourceAccessor', members: ['group:family@example.com'] },
        { role: 'roles/iap.httpsResourceAccessor', members: ['user:stranger@example.com'] },
        { role: 'roles/iap.admin', members: ['user:owner@example.com'] },
      ];
      const services = { paperwork: EDGE, 'paperwork-app': APP_WITH_FEED };
      const runs = await Promise.all(extras.map(extra => script('guard.sh', services, good.env, SPLIT_LINES, '', { 'iap-policy.json': iapPolicy(extra) })));
      runs.forEach((run, i) => {
        expect(run.code, extras[i].members[0]).toBe(1);
        expect(run.stdout).toContain(`FAILED: IAP lets through more than it should to paperwork-app: ${extras[i].members[0]} (${extras[i].role})`);
      });
      const github = await script('guard.sh', services, { ...good.env, GITHUB_ACTIONS: 'true' }, SPLIT_LINES, '', { 'iap-policy.json': iapPolicy(...extras) });
      expect(github.code).toBe(0);
      expect(github.stdout).toContain('::warning::IAP lets through more than it should to paperwork-app: allUsers (roles/iap.httpsResourceAccessor), domain:example.com');
    } finally {
      await good.close();
    }
  });

  it('only warns when it can’t read IAP’s policy', async ({ expect }) => {
    const good = await doors(401);
    try {
      const run = await script('guard.sh', { paperwork: EDGE, 'paperwork-app': APP_WITH_FEED }, good.env, SPLIT_LINES);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain("Warning: Couldn't read who IAP lets through to paperwork-app");
    } finally {
      await good.close();
    }
  });
});

// protect.sh isolate against a stateful fake: the project's IAM policy ($FAKE_STATE/policy.json) changes with each
// add and remove, and Paperwork (curl) reads its database as that policy allows. Another app's account in the
// project (OTHER_SA) may use every database, and isolate leaves it as it is. A
// condition naming the database grants it, unless FAKE_REFUSED names that database (its form doesn't match after all).
// sleep returns at once, or with FAKE_KILL stops the script in the middle of its check.
const OTHER_SA = `other-server@${PROJECT}.iam.gserviceaccount.com`;
const IAM_JS = `const fs = require('fs');
const file = process.env.FAKE_STATE + '/policy.json';
const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
const [command, ...rest] = process.argv.slice(2);
const flag = name => (rest.find(a => a.startsWith('--' + name + '=')) || '').slice(name.length + 3);
if (command === 'add' || command === 'remove') {
  let condition;
  if (flag('condition') !== 'None') {
    const yaml = fs.readFileSync(flag('condition-from-file'), 'utf8');
    condition = { expression: yaml.match(/^expression: (.*)$/m)[1], title: yaml.match(/^title: (.*)$/m)[1] };
  }
  const member = flag('member');
  let binding = policy.bindings.find(b => b.role === flag('role') && JSON.stringify(b.condition) === JSON.stringify(condition));
  if (command === 'add') {
    if (!binding) policy.bindings.push((binding = { role: flag('role'), members: [], condition }));
    if (!binding.members.includes(member)) binding.members.push(member);
  } else {
    if (!binding || !binding.members.includes(member)) process.exit(1);
    binding.members = binding.members.filter(m => m !== member);
  }
  policy.bindings = policy.bindings.filter(b => b.members.length);
  fs.writeFileSync(file, JSON.stringify(policy));
} else {
  const [member, database] = rest;
  const reads = policy.bindings.some(b => b.role === 'roles/datastore.user' && b.members.includes(member) &&
    (!b.condition || (process.env.FAKE_REFUSED !== database && b.condition.expression === 'resource.name == "projects/${PROJECT}/databases/' + database + '"')));
  process.exit(reads ? 0 : 1);
}
`;
const FAKE_PROTECT_GCLOUD = `#!/usr/bin/env bash
(IFS=$'\\x1f'; echo "$*") >>"$FAKE_STATE/calls"
iam() { node "$(dirname "$0")/iam.js" "$@"; }
case "$*" in
  "config get-value account"*) echo owner@example.com ;;
  "projects describe "*"value(projectNumber)"*) echo ${NUMBER} ;;
  "projects get-iam-policy "*) [ -z "$FAKE_NO_PROJECT_POLICY" ] || exit 1; cat "$FAKE_STATE/policy.json" ;;
  "projects add-iam-policy-binding "*) iam add "$@" ;;
  "projects remove-iam-policy-binding "*) iam remove "$@" ;;
  "run services describe "*) [ -f "$FAKE_STATE/service-$4.json" ] && cat "$FAKE_STATE/service-$4.json" || exit 1 ;;
  "iam service-accounts describe "*) [ -e "$FAKE_STATE/account-$4" ] || exit 1 ;;
  "run deploy --help"*) echo "  --[no-]iap" ;;
  "secrets get-iam-policy "*) cat "$FAKE_STATE/secret-$3.json" 2>/dev/null || echo '{}' ;;
  "iam service-accounts get-iam-policy "*) cat "$FAKE_STATE/sa-$4.json" 2>/dev/null || echo '{}' ;;
  "iap web get-iam-policy "*) cat "$FAKE_STATE/iap-policy.json" 2>/dev/null || echo '{}' ;;
  "iap web add-iam-policy-binding "*)
    # FAKE_IAP_NO_CONDITION: IAP takes no condition on the path 
    if [ -n "$FAKE_IAP_NO_CONDITION" ] && [[ "$*" != *"--condition=None"* ]]; then echo "ERROR: (gcloud.iap.web.add-iam-policy-binding) INVALID_ARGUMENT: conditions are not supported here" >&2; exit 1; fi ;;
  "iam service-accounts sign-jwt "*) node "$(dirname "$0")/svc.js" sign "$4" "$5" ;;
  "run services update "*) node "$(dirname "$0")/svc.js" unset "$FAKE_STATE/service-$4.json" FINANCE_READER_ACCOUNT ;;
  *) ;;
esac
`;
// What curl's -w '%{http_code}' prints: Paperwork's token endpoint 401 while it reads its store, else 500; the first
// FAKE_LATE answers as before any change (Google applying it late)
const FAKE_CURL = `#!/usr/bin/env bash
for a in "$@"; do url="$a"; done
case "$url" in
  */internal/finance/* | */api/session | */internal/cron) node "$(dirname "$0")/feed.js" "$@" ;;
  */oauth/token)
    n=$(( $(cat "$FAKE_STATE/token-calls" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$FAKE_STATE/token-calls"
    if [ "$n" -le "\${FAKE_LATE:-0}" ] || node "$(dirname "$0")/iam.js" reads serviceAccount:${RUN_SA} '(default)'; then printf 401; else printf 500; fi ;;
  */health) printf 200 ;;
  *) printf 000 ;;
esac
`;
// A signed JWT is "fake.jwt.<its audience>"; services' settings change as deploy.sh and gcloud run services update
// would change them
const SVC_JS = `const fs = require('fs');
const [command, ...rest] = process.argv.slice(2);
if (command === 'sign') {
  const [claims, out] = rest;
  fs.writeFileSync(out, 'fake.jwt.' + JSON.parse(fs.readFileSync(claims, 'utf8')).aud);
} else {
  const [file, name, value] = rest;
  const service = JSON.parse(fs.readFileSync(file, 'utf8'));
  const container = service.spec.template.spec.containers[0];
  container.env = (container.env || []).filter(e => e.name !== name);
  if (command === 'set') container.env.push({ name, value });
  fs.writeFileSync(file, JSON.stringify(service));
}
`;
// The app behind IAP as protect.sh finance asks it, with the JWT from the header file: answers per audience (or '*'),
// then per "METHOD path", from $FAKE_STATE/feed-answers.json as [status, generated by IAP, body]. Each call is noted.
// The first FAKE_IAP_LATE calls IAP refuses whatever they are (Google applying F2's grant late).
const FEED_JS = `const fs = require('fs');
const args = process.argv.slice(2);
const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
fs.appendFileSync(process.env.FAKE_STATE + '/calls', ['curl', ...args].join('\\x1f') + '\\n');
const url = new URL(args[args.length - 1]);
const header = (flag('-H') || '').startsWith('@') ? fs.readFileSync(flag('-H').slice(1), 'utf8') : '';
const jwt = (/Bearer (\\S+)/.exec(header) || [])[1] || '';
const audience = jwt.startsWith('fake.jwt.') ? jwt.slice('fake.jwt.'.length) : '';
const answers = JSON.parse(fs.readFileSync(process.env.FAKE_STATE + '/feed-answers.json', 'utf8'));
const route = (flag('-X') || 'GET') + ' ' + url.pathname;
const late = process.env.FAKE_STATE + '/feed-calls';
const n = (fs.existsSync(late) ? Number(fs.readFileSync(late, 'utf8')) : 0) + 1;
fs.writeFileSync(late, String(n));
const [status, iap, body] = n <= Number(process.env.FAKE_IAP_LATE || 0) ? [403, true, ''] : (answers[audience] || {})[route] || (answers['*'] || {})[route] || [404, false, ''];
fs.writeFileSync(flag('-D'), 'HTTP/1.1 ' + status + '\\r\\n' + (iap ? 'x-goog-iap-generated-response: true\\r\\n' : '') + '\\r\\n');
fs.writeFileSync(flag('-o'), typeof body === 'string' ? body : JSON.stringify(body));
process.stdout.write(String(status));
`;
const FAKE_SLEEP = `#!/bin/sh
if [ "$1" = 30 ] && [ -n "$FAKE_KILL" ]; then kill -TERM "$PPID"; fi
exit 0
`;

let protectBin: string;
beforeAll(() => {
  protectBin = path.join(tmp, 'protect-bin');
  fs.mkdirSync(protectBin);
  fs.writeFileSync(path.join(protectBin, 'iam.js'), IAM_JS);
  fs.writeFileSync(path.join(protectBin, 'svc.js'), SVC_JS);
  fs.writeFileSync(path.join(protectBin, 'feed.js'), FEED_JS);
  for (const [name, text] of [['gcloud', FAKE_PROTECT_GCLOUD], ['curl', FAKE_CURL], ['sleep', FAKE_SLEEP]]) fs.writeFileSync(path.join(protectBin, name), text, { mode: 0o755 });
});

// Paperwork as one service, and its account and another app's may use every database
function project(): string {
  const state = path.join(tmp, `project-${++runs}`);
  fs.mkdirSync(state);
  const policy = { bindings: [
    { role: 'roles/datastore.user', members: [`serviceAccount:${RUN_SA}`, `serviceAccount:${OTHER_SA}`] },
    { role: 'roles/owner', members: ['user:owner@example.com'] },
  ] };
  fs.writeFileSync(path.join(state, 'policy.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(state, 'service-paperwork.json'), described(ONE));
  for (const account of [RUN_SA, OTHER_SA]) fs.writeFileSync(path.join(state, `account-${account}`), '');
  return state;
}

// protect.sh with the given answers on stdin. `changes`: the policy changes made, in order; `shown`: the ones a dry run
// shows; `access`: who may use Firestore now, and where
async function protect(state: string, args: string[], answers = '', env: Record<string, string> = {}, prepare?: (dir: string) => void) {
  const dir = path.join(tmp, `run-${++runs}`);
  fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true });
  for (const file of ['config.sh', 'protect.sh']) fs.copyFileSync(path.join(ROOT, 'deploy', file), path.join(dir, 'deploy', file));
  copyDeployEnv(dir);
  prepare?.(dir);
  fs.writeFileSync(path.join(state, 'calls'), '');
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = execFile('bash', [path.join('deploy', 'protect.sh'), ...args], { cwd: dir, env: { PATH: `${protectBin}:${process.env.PATH}`, HOME: dir, FAKE_STATE: state, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    );
    child.stdin?.end(answers);
  });
  const calls = fs.readFileSync(path.join(state, 'calls'), 'utf8').split('\n').filter(Boolean).map(line => line.split('\x1f'));
  // "add paperwork-server with a condition", "remove paperwork-server for every database", …
  const change = (verb: string, args: string[]) => {
    const member = (args.find(a => a.startsWith('--member=')) ?? '').replace(/^--member=serviceAccount:|@.*$/g, '');
    return `${verb} ${member} ${args.includes('--condition=None') ? 'for every database' : 'with a condition'}`;
  };
  const changes = calls.filter(c => c[0] === 'projects' && c[1].endsWith('-iam-policy-binding')).map(c => change(c[1].split('-')[0], c));
  const shown = result.stderr
    .split('\n')
    .filter(line => line.startsWith('  $ gcloud projects '))
    .map(line => line.split(' ').slice(4))
    .map(c => change(c[1].split('-')[0], c));
  const policy = JSON.parse(fs.readFileSync(path.join(state, 'policy.json'), 'utf8')) as { bindings: { role: string; members: string[]; condition?: { expression: string; title: string } }[] };
  const access = policy.bindings
    .filter(b => b.role === 'roles/datastore.user')
    .flatMap(b => b.members.map(m => `${m.replace(/^serviceAccount:|@.*$/g, '')}: ${b.condition ? `${b.condition.title}, ${b.condition.expression}` : 'every database'}`))
    .sort();
  return { ...result, output: result.stdout + result.stderr, calls, changes, shown, access };
}

const BEFORE = ['other-server: every database', 'paperwork-server: every database'];
const PAPERWORK_ONLY = `paperwork-server: paperwork-default-db-only, resource.name == "projects/${PROJECT}/databases/(default)"`;
const ISOLATED = ['add paperwork-server with a condition', 'remove paperwork-server for every database'];

describe.concurrent('protect.sh isolate', SLOW, () => {
  it('with --dry-run shows each change, every database taken away only after the condition, and makes none', async ({ expect }) => {
    const state = project();
    const run = await protect(state, ['isolate', '--dry-run']);
    expect(run.code).toBe(0);
    expect(run.shown).toEqual(ISOLATED);
    expect(run.changes).toEqual([]);
    expect(run.calls.some(c => c[0] === 'scheduler')).toBe(false);
    expect(run.access).toEqual(BEFORE);
  });

  it('limits Paperwork’s account to its own database once Paperwork is seen to work, and changes nothing when run again', async ({ expect }) => {
    const state = project();
    // Yes to both of Paperwork's steps
    const run = await protect(state, ['isolate'], 'y\ny\n');
    expect(run.code).toBe(0);
    expect(run.changes).toEqual(ISOLATED);
    // Another app's account is left as it is, and named as what's left to do
    expect(run.access).toEqual(['other-server: every database', PAPERWORK_ONLY]);
    expect(run.output).toContain('Paperwork reads its store with access to (default) alone.');
    expect(run.output).toContain("Other apps' accounts in this project");
    expect(run.calls.some(c => c[0] === 'scheduler')).toBe(false);
    const again = await protect(state, ['isolate']);
    expect(again.code).toBe(0);
    expect(again.changes).toEqual([]);
  });

  it('gives Paperwork every database back when it can’t read its store with the condition alone', async ({ expect }) => {
    const state = project();
    const run = await protect(state, ['isolate'], 'y\ny\n\n', { FAKE_REFUSED: '(default)' });
    expect(run.code).toBe(1);
    expect(run.output).toContain('the condition doesn\'t match');
    expect(run.changes).toEqual(['add paperwork-server with a condition', 'remove paperwork-server for every database', 'add paperwork-server for every database']);
    expect(run.access).toEqual([...BEFORE, PAPERWORK_ONLY].sort());
  });

  it('watches Paperwork for 15 minutes, so a change Google applies late still counts', async ({ expect }) => {
    const state = project();
    // The access to every database ends only after 8 minutes, and the condition doesn't match
    const run = await protect(state, ['isolate'], 'y\ny\n\n', { FAKE_REFUSED: '(default)', FAKE_LATE: '16' });
    expect(run.code).toBe(1);
    expect(run.output).toContain('the condition doesn\'t match');
    expect(run.access).toEqual([...BEFORE, PAPERWORK_ONLY].sort());
  });

  it('gives the access back when stopped before the check is done', async ({ expect }) => {
    const state = project();
    const run = await protect(state, ['isolate'], 'y\ny\n\n', { FAKE_KILL: '1' });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('Stopped before it was checked');
    expect(run.changes).toEqual(['add paperwork-server with a condition', 'remove paperwork-server for every database', 'add paperwork-server for every database']);
    expect(run.access).toEqual([...BEFORE, PAPERWORK_ONLY].sort());
  });
});

// protect.sh split, up to where it starts asking about the owner's account (answered with one it refuses, so it stops
// there): it runs from a checkout that is origin's, of the commit GitHub deployed, and only after isolate
describe.concurrent('protect.sh split, before it changes anything', SLOW, () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' },
    })
      .toString()
      .trim();
  // A checkout of main, pushed to its origin (but for one commit, with `unpushed`); paperwork runs `runs` (the
  // commit itself with 'this commit')
  const checkout = (state: string, runs: 'this commit' | 'an older commit', unpushed = false) => (dir: string) => {
    const origin = `${dir}-origin.git`;
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Paperwork');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', 'origin', 'main');
    if (unpushed) git(dir, 'commit', '-q', '--allow-empty', '-m', 'Not pushed yet');
    const image = `${IMAGE.split(':')[0]}:${runs === 'this commit' ? git(dir, 'rev-parse', 'HEAD') : 'f'.repeat(40)}`;
    fs.writeFileSync(path.join(state, 'service-paperwork.json'), described({ ...ONE, image }));
  };
  // After isolate: Paperwork's account may use its database only
  const isolated = (state: string) =>
    fs.writeFileSync(
      path.join(state, 'policy.json'),
      JSON.stringify({ bindings: [{ role: 'roles/datastore.user', members: [`serviceAccount:${RUN_SA}`], condition: { expression: `resource.name == "projects/${PROJECT}/databases/(default)"`, title: 'paperwork-default-db-only' } }] })
    );
  const STRANGER = 'stranger@example.com\n';

  it('goes on from a pushed checkout that paperwork runs, after isolate', async ({ expect }) => {
    const state = project();
    isolated(state);
    const run = await protect(state, ['split'], STRANGER, {}, checkout(state, 'this commit'));
    expect(run.output).toContain("isn't in Paperwork's ALLOWED_EMAILS");
    expect(run.output).toContain("Don't push to main");
    expect(run.code).toBe(1);
    expect(run.changes).toEqual([]);
  });

  it('refuses a checkout with commits origin doesn’t have', async ({ expect }) => {
    const state = project();
    isolated(state);
    const run = await protect(state, ['split'], STRANGER, {}, checkout(state, 'this commit', true));
    expect(run.code).toBe(1);
    expect(run.output).toContain("This checkout isn't origin/main");
    expect(run.output).not.toContain('ALLOWED_EMAILS');
  });

  it('asks before going on while GitHub hasn’t deployed this commit yet', async ({ expect }) => {
    const state = project();
    isolated(state);
    const run = await protect(state, ['split'], 'n\n', {}, checkout(state, 'an older commit'));
    expect(run.code).toBe(0);
    expect(run.output).toContain("paperwork doesn't run this commit");
    expect(run.output).toContain('Stopped here');
    const anyway = await protect(state, ['split'], `y\n${STRANGER}`, {}, checkout(state, 'an older commit'));
    expect(anyway.output).toContain("isn't in Paperwork's ALLOWED_EMAILS");
  });

  it('refuses to go on before isolate has limited Paperwork to its database', async ({ expect }) => {
    const state = project();
    const run = await protect(state, ['split'], STRANGER, {}, checkout(state, 'this commit'));
    expect(run.code).toBe(1);
    expect(run.output).toContain('Run deploy/protect.sh isolate first');
    expect(run.output).not.toContain('ALLOWED_EMAILS');
    expect(run.changes).toEqual([]);
  });
});

// protect.sh finance against the stateful fakes: Paperwork as two services, Finance's account as Finance's setup.sh
// leaves it (its own database only, and a role that reaches nothing of Paperwork's), deploy.sh stood in for by a stub
// that notes how it was called and gives the app the setting
describe.concurrent('protect.sh finance', SLOW, () => {
  type Binding = { role: string; members: string[]; condition?: { expression: string; title: string } };
  const FEED_CONDITION = '--condition=expression=request.path.startsWith("/internal/finance/"),title=finance-feed-only';
  const AUD_FEED = `${APP_URL}/internal/finance/*`;
  const AUD_APP = `${APP_URL}/*`;
  const ROUTES = ['GET /internal/finance/contracts', 'GET /internal/finance/purchases', 'GET /api/session', 'POST /internal/cron'];
  const everywhere = (answer: [number, boolean, unknown]) => Object.fromEntries(ROUTES.map(r => [r, answer]));
  // IAP refuses Finance's JWT for the feed's audience; for the whole app it lets it through, and Paperwork serves the
  // feed and refuses the rest
  const WHOLE_APP_ONLY = {
    [AUD_FEED]: everywhere([302, true, '']),
    [AUD_APP]: {
      'GET /internal/finance/contracts': [200, false, { version: 1, contracts: [{ name: 'Secret contract name' }, { name: 'Another' }] }],
      'GET /internal/finance/purchases': [200, false, { version: 1, receipts: [] }],
      'GET /api/session': [403, false, 'Forbidden'],
      'POST /internal/cron': [403, false, 'Forbidden'],
    },
  };

  function financeProject(extra: Binding[] = [], files: Record<string, unknown> = {}, accounts = [RUN_SA, EDGE_SA, FINANCE]): string {
    const state = path.join(tmp, `project-${++runs}`);
    fs.mkdirSync(path.join(state, 'tmp'), { recursive: true });
    const policy = {
      bindings: [
        { role: 'roles/datastore.user', members: [`serviceAccount:${RUN_SA}`, `serviceAccount:${EDGE_SA}`], condition: { expression: `resource.name == "projects/${PROJECT}/databases/(default)"`, title: 'paperwork-default-db-only' } },
        { role: 'roles/datastore.user', members: [`serviceAccount:${FINANCE}`], condition: { expression: `resource.name == "projects/${PROJECT}/databases/finance"`, title: 'finance-own-db-only' } },
        { role: 'roles/logging.logWriter', members: [`serviceAccount:${FINANCE}`] },
        { role: 'roles/owner', members: ['user:owner@example.com'] },
        ...extra,
      ],
    };
    fs.writeFileSync(path.join(state, 'policy.json'), JSON.stringify(policy));
    fs.writeFileSync(path.join(state, 'service-paperwork.json'), described({ ...EDGE, image: IMAGE }));
    fs.writeFileSync(path.join(state, 'service-paperwork-app.json'), described({ ...APP, image: IMAGE }));
    for (const account of accounts) fs.writeFileSync(path.join(state, `account-${account}`), '');
    for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(state, file), JSON.stringify(value));
    return state;
  }

  // deploy/deploy.sh as F3 runs it: noted with the settings it was given; the app then carries the account
  const withDeployStub = (dir: string) =>
    fs.writeFileSync(
      path.join(dir, 'deploy', 'deploy.sh'),
      `#!/usr/bin/env bash
printf 'deploy.sh\\x1fDEPLOY_ONLY=%s\\x1fAPP_SERVICE=%s\\x1fEDGE_SA=%s\\x1fIMAGE=%s\\x1fFINANCE_READER_ACCOUNT=%s\\n' "$DEPLOY_ONLY" "$APP_SERVICE" "$EDGE_SA" "$IMAGE" "$FINANCE_READER_ACCOUNT" >>"$FAKE_STATE/calls"
node "$(dirname "$(command -v gcloud)")/svc.js" set "$FAKE_STATE/service-$APP_SERVICE.json" FINANCE_READER_ACCOUNT "$FINANCE_READER_ACCOUNT"
`,
      { mode: 0o755 }
    );

  async function finance(state: string, args: string[], answers: string, env: Record<string, string> = {}, prepare?: (dir: string) => void) {
    fs.mkdirSync(path.join(state, 'tmp'), { recursive: true });
    const run = await protect(state, ['finance', ...args], answers, { TMPDIR: path.join(state, 'tmp'), ...env }, dir => {
      withDeployStub(dir);
      prepare?.(dir);
    });
    const appFile = path.join(state, 'service-paperwork-app.json');
    const app = fs.existsSync(appFile) ? JSON.parse(fs.readFileSync(appFile, 'utf8')) : { spec: { template: { spec: { containers: [{ env: [] }] } } } };
    // What changed, in order: IAP's grant, the deploy (F3), the setting taken off
    const steps = run.calls
      .filter(c => (c[0] === 'iap' && c[2] !== 'get-iam-policy') || c[0] === 'deploy.sh' || (c[0] === 'run' && c[2] === 'update'))
      .map(c => (c[0] === 'iap' ? `iap ${c[2]} ${c.find(a => a.startsWith('--condition=')) === '--condition=None' ? 'none' : 'condition'}` : c[0] === 'deploy.sh' ? 'deploy' : `update ${c.slice(-2).join(' ')}`));
    const feedEnv = (app.spec.template.spec.containers[0].env as { name: string; value: string }[]).find(e => e.name === 'FINANCE_READER_ACCOUNT')?.value ?? '';
    // Whatever is left in the temporary folders, and every argument any command was given
    const left = fs.readdirSync(path.join(state, 'tmp'), { recursive: true }).map(String);
    return { ...run, steps, feedEnv, left, args: run.calls.flat() };
  }

  const shownCommands = (stderr: string) =>
    stderr
      .split('\n')
      .filter(line => line.startsWith('  $ '))
      .map(line => line.slice(4));

  it('with --dry-run shows F2’s grant and F3’s deploy, then F4’s calls, and changes nothing', async ({ expect }) => {
    const state = financeProject();
    const run = await finance(state, ['--dry-run'], '');
    expect(run.code).toBe(0);
    for (const step of ['== F1. ', '== F2. ', '== F3. ', '== F4. ']) expect(run.stdout).toContain(step);
    const shown = shownCommands(run.stderr);
    expect(shown[0]).toBe(
      `gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=paperwork-app --region=europe-west3 --project ${PROJECT} --member=serviceAccount:${FINANCE} --role=roles/iap.httpsResourceAccessor '${FEED_CONDITION}'`
    );
    expect(shown[1]).toBe(`env DEPLOY_ONLY=app APP_SERVICE=paperwork-app EDGE_SA=${EDGE_SA} IMAGE=${IMAGE} FINANCE_READER_ACCOUNT=${FINANCE} deploy/deploy.sh`);
    expect(shown[2]).toMatch(/^gcloud iam service-accounts sign-jwt \S+claims\.json \S+feed\.jwt --iam-account=finance-server@/);
    expect(shown[5]).toBe(shown[2]);
    expect(shown.slice(3).map(c => c.replace(/@\S+feed-header/, '@HEADER'))).toEqual([
      `curl -sS -H @HEADER ${APP_URL}/internal/finance/contracts`,
      expect.stringMatching(new RegExp(`^curl -sS -H @HEADER '${APP_URL}/internal/finance/purchases\\?since=\\d{4}-\\d{2}-\\d{2}'$`)),
      shown[2],
      `curl -sS -H @HEADER ${APP_URL}/api/session`,
      `curl -sS -X POST -H @HEADER --data '' ${APP_URL}/internal/cron`,
    ]);
    expect(run.output).toContain(`then with aud ${AUD_APP}:`);
    expect(run.steps).toEqual([]);
    expect(run.calls.some(c => c[0] === 'curl' || c[2] === 'sign-jwt')).toBe(false);
    expect(run.feedEnv).toBe('');
  });

  it('stops before split: the feed is served by the app behind IAP', async ({ expect }) => {
    const state = project();
    const run = await finance(state, ['--dry-run'], '');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Run deploy/protect.sh split first');
    expect(run.stdout).not.toContain('== F1.');
  });

  it('stops without Finance’s account', async ({ expect }) => {
    const state = financeProject([], {}, [RUN_SA, EDGE_SA]);
    const run = await finance(state, [], 'y\n');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Run Finance's deploy/setup.sh first");
    expect(run.steps).toEqual([]);
  });

  it('asks before going on when the app runs another commit than this checkout, and goes on quietly when it runs it', async ({ expect }) => {
    const state = financeProject();
    const no = await finance(state, [], 'n\n');
    expect(no.code).toBe(0);
    expect(no.output).toContain('not this checkout');
    expect(no.output).toContain('Stopped here');
    expect(no.steps).toEqual([]);
    // A checkout whose commit the app's image is tagged with
    const same = await finance(state, ['--dry-run'], '', {}, dir => {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' } }).toString().trim();
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'Paperwork');
      fs.writeFileSync(path.join(state, 'service-paperwork-app.json'), described({ ...APP, image: `${IMAGE.split(':')[0]}:${git('rev-parse', 'HEAD')}` }));
    });
    expect(same.output).toContain("runs this checkout's commit");
    expect(same.output).not.toContain('Go on anyway');
  });

  // F1: each way Finance's account could get at Paperwork other than the feed stops it, before anything changes
  const reach: [string, Binding[], Record<string, unknown>, string][] = [
    ['Firestore without a condition', [{ role: 'roles/datastore.user', members: [`serviceAccount:${FINANCE}`] }], {}, 'the project gives it roles/datastore.user without a condition'],
    [
      'Firestore for another database (Paperwork’s)',
      [{ role: 'roles/datastore.user', members: [`serviceAccount:${FINANCE}`], condition: { expression: `resource.name == "projects/${PROJECT}/databases/(default)"`, title: 'finance-paperwork' } }],
      {},
      'the project gives it roles/datastore.user with the condition finance-paperwork',
    ],
    ['a project-wide editor', [{ role: 'roles/editor', members: [`serviceAccount:${FINANCE}`] }], {}, 'the project gives it roles/editor without a condition'],
    ['Paperwork’s secrets, project-wide', [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${FINANCE}`] }], {}, 'the project gives it roles/secretmanager.secretAccessor'],
    ['a custom role', [{ role: `projects/${PROJECT}/roles/reader`, members: [`serviceAccount:${FINANCE}`] }], {}, `the project gives it the custom role projects/${PROJECT}/roles/reader`],
    [
      'one of Paperwork’s secrets',
      [],
      { 'secret-paperwork-app-secret.json': { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${FINANCE}`] }] } },
      'the secret paperwork-app-secret gives it roles/secretmanager.secretAccessor',
    ],
    [
      'signing as Paperwork’s edge',
      [],
      { [`sa-${EDGE_SA}.json`]: { bindings: [{ role: 'roles/iam.serviceAccountTokenCreator', members: [`serviceAccount:${FINANCE}`] }] } },
      `Paperwork's account ${EDGE_SA} gives it roles/iam.serviceAccountTokenCreator`,
    ],
  ];
  for (const [what, extra, files, finding] of reach) {
    it(`F1 stops on ${what}, changing nothing`, async ({ expect }) => {
      const run = await finance(financeProject(extra, files), [], 'y\ny\ny\ny\n');
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(finding);
      expect(run.stderr).toContain('Nothing was changed.');
      expect(run.stdout).not.toContain('== F2.');
      expect(run.steps).toEqual([]);
    });
  }

  it('F4 tries the feed’s audience, then the whole app’s, and says which to give Finance; nothing of the feed is printed and the JWT goes nowhere', async ({ expect }) => {
    const state = financeProject([], { 'feed-answers.json': WHOLE_APP_ONLY });
    const run = await finance(state, [], 'y\ny\ny\ny\n');
    expect(run.code).toBe(0);
    expect(run.steps).toEqual(['iap add-iam-policy-binding condition', 'deploy']);
    expect(run.calls).toContainEqual([
      'iap', 'web', 'add-iam-policy-binding', '--resource-type=cloud-run', '--service=paperwork-app', '--region=europe-west3', '--project', PROJECT,
      `--member=serviceAccount:${FINANCE}`, '--role=roles/iap.httpsResourceAccessor', FEED_CONDITION,
    ]);
    expect(run.calls).toContainEqual(['deploy.sh', 'DEPLOY_ONLY=app', 'APP_SERVICE=paperwork-app', `EDGE_SA=${EDGE_SA}`, `IMAGE=${IMAGE}`, `FINANCE_READER_ACCOUNT=${FINANCE}`]);
    expect(run.feedEnv).toBe(FINANCE);
    expect(run.output).toContain(`aud ${AUD_FEED}:\n    GET /internal/finance/contracts: 302 from IAP`);
    expect(run.output).toContain('GET /internal/finance/contracts: 200, 2 contracts');
    expect(run.output).toContain('GET /api/session: 403 from Paperwork, refused as it should be');
    expect(run.output).toContain(`C1: IAP takes Finance's JWT for aud ${AUD_APP} (aud ${AUD_FEED}: 302 from IAP).`);
    expect(run.output).toContain('C2: IAP took the grant with the condition');
    expect(run.output).toContain('C3: GET /internal/finance/purchases?since=');
    expect(run.output).toContain(`PAPERWORK_URL=${APP_URL} PAPERWORK_FEED_AUDIENCE=${AUD_APP} bash deploy/deploy.sh`);
    expect(run.output).not.toContain('Secret contract name');
    // Each audience asked for the feed, then the whole app's JWT the other two doors, with the JWT from a file only
    const curls = run.calls.filter(c => c[0] === 'curl');
    expect(curls.map(c => `${c[c.indexOf('-X') + 1]} ${new URL(c.at(-1)!).pathname}`)).toEqual([...ROUTES.slice(0, 2), ...ROUTES]);
    expect(curls.every(c => c[c.indexOf('-H') + 1].endsWith('/feed-header') && c.at(-1)!.startsWith(APP_URL))).toBe(true);
    expect(run.calls.filter(c => c[2] === 'sign-jwt').map(c => c.at(-3))).toEqual(Array(3).fill(`--iam-account=${FINANCE}`));
    expect(run.args.some(a => a.includes('fake.jwt'))).toBe(false);
    expect(run.output).not.toContain('fake.jwt');
    expect(run.left).toEqual([]);
  });

  it('F4 waits while Google applies F2’s new grant on IAP, then tests again, and takes nothing back', async ({ expect }) => {
    const state = financeProject([], { 'feed-answers.json': { '*': WHOLE_APP_ONLY[AUD_APP] } });
    // Four rounds of both audiences (two calls each) refused by IAP, then the grant applies
    const run = await finance(state, [], 'y\ny\ny\ny\n', { FAKE_IAP_LATE: '16' });
    expect(run.code).toBe(0);
    expect(run.steps).toEqual(['iap add-iam-policy-binding condition', 'deploy']);
    expect(run.feedEnv).toBe(FINANCE);
    expect(run.output).toContain('IAP refused both audiences while its grant (F2) is new');
    expect(run.calls.filter(c => c[0] === 'curl')).toHaveLength(4 * 4 + 4);
    // The audience that worked once the grant applied, not the one tried last before
    expect(run.output).toContain(`C1: IAP takes Finance's JWT for aud ${AUD_FEED}.`);
    expect(run.output).toContain(`PAPERWORK_URL=${APP_URL} bash deploy/deploy.sh`);
    expect(run.output).not.toContain('fake.jwt');
    expect(run.left).toEqual([]);
  });

  it('F4 doesn’t wait when Paperwork refuses, or when the grant on IAP was there before this run', async ({ expect }) => {
    const paperwork = await finance(financeProject([], { 'feed-answers.json': { '*': everywhere([403, false, 'Forbidden']) } }), [], 'y\ny\ny\ny\n');
    expect(paperwork.code).toBe(1);
    expect(paperwork.output).not.toContain('while its grant (F2) is new');
    expect(paperwork.calls.filter(c => c[0] === 'curl')).toHaveLength(4);
    const before = financeProject([], {
      'feed-answers.json': { '*': everywhere([403, true, '']) },
      'iap-policy.json': { bindings: [{ role: 'roles/iap.httpsResourceAccessor', members: [`serviceAccount:${FINANCE}`] }] },
    });
    const again = await finance(before, [], 'y\ny\ny\n');
    expect(again.code).toBe(1);
    expect(again.output).not.toContain('while its grant (F2) is new');
    expect(again.calls.filter(c => c[0] === 'curl')).toHaveLength(4);
  });

  it('F4 fails and takes back F2 and F3 when Finance’s JWT gets through to more than the feed', async ({ expect }) => {
    for (const door of ['GET /api/session', 'POST /internal/cron']) {
      const answers = { ...WHOLE_APP_ONLY[AUD_APP], [door]: [200, false, { ok: true }] };
      const run = await finance(financeProject([], { 'feed-answers.json': { '*': answers } }), [], 'y\ny\ny\ny\n');
      expect(run.code, door).toBe(1);
      expect(run.output).toContain(`${door}: 200 from Paperwork`);
      expect(run.output).toContain('got through to more than the feed');
      expect(run.steps).toEqual(['iap add-iam-policy-binding condition', 'deploy', 'iap remove-iam-policy-binding condition', 'update --remove-env-vars FINANCE_READER_ACCOUNT']);
      expect(run.feedEnv).toBe('');
      expect(run.output).not.toContain('PAPERWORK_URL=');
    }
  });

  it('F4 asks the other doors with a JWT for the whole app, whichever audience got the feed, and counts only a 403 as refused', async ({ expect }) => {
    const feedOnly = (session: [number, boolean, unknown], cron: [number, boolean, unknown]) => ({
      // IAP turns the feed's own JWT away from any path outside its audience, before its grant or Paperwork is asked
      [AUD_FEED]: { ...WHOLE_APP_ONLY[AUD_APP], 'GET /api/session': [401, true, ''], 'POST /internal/cron': [401, true, ''] },
      [AUD_APP]: { ...WHOLE_APP_ONLY[AUD_APP], 'GET /api/session': session, 'POST /internal/cron': cron },
    });
    // The whole app's JWT gets through to /api/session: F4 fails although the feed's own JWT was refused there
    const through = await finance(financeProject([], { 'feed-answers.json': feedOnly([200, false, { ok: true }], [403, false, 'Forbidden']) }), [], 'y\ny\ny\ny\n');
    expect(through.code).toBe(1);
    expect(through.output).toContain('GET /api/session: 200 from Paperwork');
    expect(through.output).toContain('got through to more than the feed');
    expect(through.steps).toEqual(['iap add-iam-policy-binding condition', 'deploy', 'iap remove-iam-policy-binding condition', 'update --remove-env-vars FINANCE_READER_ACCOUNT']);
    expect(through.output).not.toContain('PAPERWORK_URL=');
    // IAP's 401 or redirect for the whole app's JWT tests neither IAP's condition nor Paperwork's gate
    const notTaken = await finance(financeProject([], { 'feed-answers.json': feedOnly([401, true, ''], [302, true, '']) }), [], 'y\ny\ny\ny\n');
    expect(notTaken.code).toBe(1);
    expect(notTaken.output).toContain('GET /api/session: 401 from IAP');
    expect(notTaken.steps.slice(2)).toEqual(['iap remove-iam-policy-binding condition', 'update --remove-env-vars FINANCE_READER_ACCOUNT']);
    // IAP's 403 (its condition on the path) at both doors: the feed's audience is the one for Finance
    const refused = await finance(financeProject([], { 'feed-answers.json': feedOnly([403, true, ''], [403, true, '']) }), [], 'y\ny\ny\ny\n');
    expect(refused.code).toBe(0);
    expect(refused.output).toContain(`C1: IAP takes Finance's JWT for aud ${AUD_FEED}.`);
    expect(refused.output).toContain(`with aud ${AUD_APP}, GET /api/session was refused by IAP, POST /internal/cron by IAP.`);
    expect(refused.output).toContain(`PAPERWORK_URL=${APP_URL} bash deploy/deploy.sh`);
    expect(refused.calls.filter(c => c[2] === 'sign-jwt')).toHaveLength(2);
    expect(refused.output).not.toContain('fake.jwt');
    expect(refused.left).toEqual([]);
  });

  it('F4 takes back F2 and F3, in that order, when Finance can’t get through, and exits 1', async ({ expect }) => {
    const state = financeProject([], { 'feed-answers.json': { '*': everywhere([401, true, '']) } });
    const run = await finance(state, [], 'y\ny\ny\ny\n');
    expect(run.code).toBe(1);
    expect(run.steps).toEqual(['iap add-iam-policy-binding condition', 'deploy', 'iap remove-iam-policy-binding condition', 'update --remove-env-vars FINANCE_READER_ACCOUNT']);
    expect(run.calls).toContainEqual([
      'iap', 'web', 'remove-iam-policy-binding', '--resource-type=cloud-run', '--service=paperwork-app', '--region=europe-west3', '--project', PROJECT,
      `--member=serviceAccount:${FINANCE}`, '--role=roles/iap.httpsResourceAccessor', FEED_CONDITION,
    ]);
    expect(run.feedEnv).toBe('');
    expect(run.output).toContain("Finance's JWT didn't get through");
    expect(run.args.some(a => a.includes('fake.jwt'))).toBe(false);
    expect(run.output).not.toContain('fake.jwt');
    expect(run.left).toEqual([]);
    // Done before this run: left as it is
    const before = financeProject([], {
      'feed-answers.json': { '*': everywhere([401, true, '']) },
      'iap-policy.json': { bindings: [{ role: 'roles/iap.httpsResourceAccessor', members: [`serviceAccount:${FINANCE}`] }] },
    });
    fs.writeFileSync(path.join(before, 'service-paperwork-app.json'), described({ ...APP, image: IMAGE, env: { ...APP.env, FINANCE_READER_ACCOUNT: FINANCE } }));
    const again = await finance(before, [], 'y\ny\n');
    expect(again.code).toBe(1);
    expect(again.steps).toEqual([]);
    expect(again.output).toContain('Steps F2 and F3 were done before this run');
    expect(again.feedEnv).toBe(FINANCE);
  });

  it('run again once it works, changes nothing and tests again', async ({ expect }) => {
    const state = financeProject([], {
      'feed-answers.json': { '*': WHOLE_APP_ONLY[AUD_APP] },
      'iap-policy.json': { bindings: [{ role: 'roles/iap.httpsResourceAccessor', members: [`serviceAccount:${FINANCE}`] }] },
    });
    fs.writeFileSync(path.join(state, 'service-paperwork-app.json'), described({ ...APP, image: IMAGE, env: { ...APP.env, FINANCE_READER_ACCOUNT: FINANCE } }));
    // The image question, then F4's
    const run = await finance(state, [], 'y\ny\n');
    expect(run.code).toBe(0);
    expect(run.steps).toEqual([]);
    expect(run.output).toContain(`Done already: IAP lets ${FINANCE} through to paperwork-app.`);
    expect(run.output).toContain(`Done already: paperwork-app serves the feed to ${FINANCE}.`);
    expect(run.output).toContain('C2: the grant on IAP was there before this run (without a condition)');
    expect(run.output).toContain(`PAPERWORK_URL=${APP_URL} bash deploy/deploy.sh`);
    expect(run.output).not.toContain('PAPERWORK_FEED_AUDIENCE');
  });

  it('F2 offers the grant without the condition on the path when IAP refuses that condition', async ({ expect }) => {
    const state = financeProject([], { 'feed-answers.json': WHOLE_APP_ONLY });
    const run = await finance(state, [], 'y\ny\ny\ny\ny\n', { FAKE_IAP_NO_CONDITION: '1' });
    expect(run.code).toBe(0);
    expect(run.steps).toEqual(['iap add-iam-policy-binding condition', 'iap add-iam-policy-binding none', 'deploy']);
    expect(run.stderr).toContain('conditions are not supported here');
    expect(run.output).toContain('C2: IAP refused the condition on the path');
  });

  it('plan doesn’t count Finance’s account as reaching nothing when it can’t read the project’s policy', async ({ expect }) => {
    const run = await protect(financeProject(), ['plan'], '', { FAKE_NO_PROJECT_POLICY: '1' });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`[ ] finance: ${FINANCE} reaches nothing of Paperwork's but the feed`);
  });

  it('plan shows the three steps of finance', async ({ expect }) => {
    const state = financeProject([], { 'iap-policy.json': { bindings: [{ role: 'roles/iap.httpsResourceAccessor', members: [`serviceAccount:${FINANCE}`] }] } });
    const run = await protect(state, ['plan']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`[x] finance: ${FINANCE} reaches nothing of Paperwork's but the feed`);
    expect(run.stdout).toContain('[x] finance: IAP lets it through to the feed');
    expect(run.stdout).toContain('[ ] finance: paperwork-app serves the feed to it');
    expect(run.stdout).toContain('deploy/protect.sh finance');
  });
});

// deploy/github-settings.sh against a fake gh that logs each call (and the JSON it was given) and answers nothing
describe.concurrent('github-settings.sh', SLOW, () => {
  const FAKE_GH = `#!/usr/bin/env bash
if [ "$1" = api ]; then
  input=""
  case " $* " in *" --input - "*) input="$(cat)" ;; esac
  (IFS=' '; echo "$*") >>"$FAKE_STATE/gh-calls"
  [ -z "$input" ] || printf '%s\\n' "$input" >>"$FAKE_STATE/gh-input"
fi
exit 0
`;
  async function settings(args: string[], answers: string) {
    const dir = path.join(tmp, `gh-${++runs}`);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true });
    fs.mkdirSync(bin);
    for (const file of ['config.sh', 'github-settings.sh']) fs.copyFileSync(path.join(ROOT, 'deploy', file), path.join(dir, 'deploy', file));
    fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    const result = await new Promise<{ code: number; output: string }>(resolve => {
      const child = execFile('bash', [path.join('deploy', 'github-settings.sh'), ...args], {
        cwd: dir,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, FAKE_STATE: dir, GITHUB_REPO: 'someone/paperwork', DEPLOY_BRANCH: 'main' },
      }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, output: stdout + stderr }));
      child.stdin?.end(answers);
    });
    const read = (name: string) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : '');
    return { ...result, calls: read('gh-calls').split('\n').filter(Boolean), input: read('gh-input') };
  }

  it('with --dry-run prints every call and makes none', async ({ expect }) => {
    const run = await settings(['--dry-run'], '');
    expect(run.code).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.output).toContain('gh api -X PUT repos/someone/paperwork/branches/main/protection');
    expect(run.output).toContain('Dry run: nothing was changed.');
  });

  it('changes nothing without a yes', async ({ expect }) => {
    const run = await settings([], 'n\n');
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([]);
  });

  it('protects the deploy branch, the production environment and the repository once you say yes', async ({ expect }) => {
    const run = await settings([], 'y\n');
    expect(run.code).toBe(0);
    expect(run.calls.map(c => c.split(' ').slice(1, 4).join(' '))).toEqual([
      '-X PUT repos/someone/paperwork/branches/main/protection',
      '-X PUT repos/someone/paperwork/environments/production',
      '-X PUT repos/someone/paperwork/actions/permissions/workflow',
      '-X PUT repos/someone/paperwork/actions/permissions/fork-pr-contributor-approval',
      '-X PATCH repos/someone/paperwork',
      '-X PUT repos/someone/paperwork/vulnerability-alerts',
      '-X PUT repos/someone/paperwork/automated-security-fixes',
      '-X PUT repos/someone/paperwork/private-vulnerability-reporting',
    ]);
    expect(run.calls[2]).toContain('default_workflow_permissions=read');
    expect(run.calls[3]).toContain('approval_policy=all_external_contributors');
    expect(run.input).toContain('"allow_force_pushes": false');
    expect(run.input).toContain('"context": "Type check, test and build"');
    expect(run.input).toContain('"protected_branches": true');
    expect(run.input).toContain('"secret_scanning_push_protection": { "status": "enabled" }');
  });
});
