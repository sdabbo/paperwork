// What each role serves (roles.ts). One service ('all') serves everything, as Paperwork always did. As two services
// from the same image, the owner's app ('app', behind Google's Identity-Aware Proxy) serves the pages, /api, /auth,
// the page allowing an AI app, the relayed scheduled run and Finance's read-only feed; the public edge ('edge') serves
// only what machines call: AI apps (MCP and OAuth), forwarded email and Cloud Scheduler, and answers 404 to everything
// else.
import express from 'express';
import path from 'path';
import { Role, config } from './config.js';
import { cronHandler } from './cron.js';
import { financeRouter } from './finance.js';
import { iapGate } from './iap.js';
import { inboundEmail } from './inbound.js';
import { mcpRouter } from './mcp.js';
import { authorizeRedirect, consentRouter, machineOAuthRouter, oauthRouter, wellKnownRouter } from './oauth.js';
import { apiRouter, authRouter } from './routes.js';

// What the deployed app's pages may load: its own scripts, Google's file picker (loaded from apis.google.com,
// shown in a frame from docs.google.com), Google's fonts, Drive's preview frame and Google profile pictures.
// Text from documents and Gemini's answers is shown as text, and this keeps it that way should anything slip
// through. Anything the policy blocks is reported to /csp-report and logged. (Not in development: Vite's live
// reload needs inline scripts.)
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://www.gstatic.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com https://*.gstatic.com https://*.google.com",
  'frame-src https://drive.google.com https://docs.google.com',
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'report-uri /csp-report',
].join('; ');

// The app's pages: Vite's development server, the built files in dist/, or none (tests)
export type Client = 'vite' | 'dist' | 'none';

export async function createApp(role: Role, options: { client: Client }): Promise<express.Express> {
  const app = express();
  app.disable('x-powered-by');
  // IAP's rule for the scheduled run compares the exact path (iap.ts), so routes must too
  if (role !== 'all') app.set('case sensitive routing', true);

  // Before anything else reads the request
  if (role === 'app') {
    app.use(iapGate({ audience: config.iapAudience, allowedEmails: () => config.allowedEmails, relayAccount: config.cronRelayAccount, financeAccount: config.financeReaderAccount }));
  }

  if (config.isProduction) {
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    });
  }

  // Health check (not /healthz: Cloud Run reserves paths ending in "z")
  app.get('/health', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  // Scheduled filing of whatever landed in the Inbox (cron.ts)
  app.post('/internal/cron', cronHandler(role));

  // Finance's read-only feed (finance.ts): only from the app behind IAP, and only once FINANCE_READER_ACCOUNT names
  // Finance's account (deploy/protect.sh finance). One service has no IAP to let Finance in, and its page fallback
  // would answer these paths with the app's page, so it answers 404; the edge's catch-all does the same.
  if (role === 'app' && config.financeReaderAccount) app.use('/internal/finance', financeRouter);
  else if (role === 'all') {
    app.use('/internal/finance', (_req, res) => {
      res.status(404).set('Cache-Control', 'no-store').end();
    });
  }

  if (role !== 'app') app.post('/inbound/email', ...inboundEmail);

  if (role !== 'edge') {
    // Reports of what the policy above blocked, so a page that misbehaves can be understood from the logs
    app.post('/csp-report', express.json({ type: ['application/csp-report', 'application/json', 'application/reports+json'], limit: '16kb' }), (req, res) => {
      const report = req.body?.['csp-report'] ?? req.body;
      console.warn('Content-Security-Policy blocked:', JSON.stringify(report).slice(0, 2000));
      res.status(204).end();
    });
  }

  // AI apps (Gemini, …): the MCP server, and how they get the owner's permission to use it
  if (role === 'all') {
    app.use('/.well-known', wellKnownRouter);
    app.use('/oauth', oauthRouter);
    app.use('/mcp', mcpRouter);
  } else if (role === 'app') {
    app.use('/oauth', consentRouter);
  } else {
    app.use('/.well-known', wellKnownRouter);
    // The owner's browser on its way to the page asking them, which the app serves
    app.get('/oauth/authorize', authorizeRedirect);
    app.use('/oauth', machineOAuthRouter);
    app.use('/mcp', mcpRouter);
  }

  if (role === 'edge') {
    // No pages, no API, no sign-in: nothing else is here
    app.use((_req, res) => {
      res.status(404).set('Cache-Control', 'no-store').end();
    });
    return app;
  }

  app.use('/auth', authRouter);
  app.use('/api', apiRouter);

  if (options.client === 'vite') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else if (options.client === 'dist') {
    const distPath = path.resolve(process.cwd(), 'dist');
    // Built files have content hashes in their names and never change; everything else is revalidated
    app.use(
      express.static(distPath, {
        index: false,
        setHeaders: (res, filePath) => {
          res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      })
    );
    // The app's pages (/inbox, /ask, …) are routed in the browser; missing files stay 404s
    app.get('/{*splat}', (req, res) => {
      // A company's or topic's page name may contain a dot ("/companies/Dr. Weber"); it isn't a file
      const file = path.extname(req.path) && !/^\/(companies|topics)\//.test(req.path);
      if (file || req.path.startsWith('/api/')) return res.status(404).end();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
  return app;
}
