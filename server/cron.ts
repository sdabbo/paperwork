// The scheduled run: Cloud Scheduler calls POST /internal/cron every few minutes to file whatever landed in the Inbox.
// As one service ('all') it is checked and run right here. As two services (roles.ts) Scheduler calls the public edge,
// which checks Scheduler's token and passes the run on to the app through IAP (relay.ts); the app runs it only for
// that relay, and answers with the summary the edge hands back to Scheduler.
import { Request, Response } from 'express';
import { verifySchedulerToken } from './auth.js';
import { Role, config } from './config.js';
import { getConnection } from './google.js';
import type { IapPrincipal } from './iap.js';
import { syncVault } from './pipeline.js';
import { relayCron } from './relay.js';

async function fileInbox(res: Response) {
  try {
    const connection = await getConnection();
    if (!connection || connection.broken) return res.json({ skipped: 'Google Drive is not connected' });
    res.json(await syncVault('schedule'));
  } catch (err: any) {
    console.error('Scheduled filing failed:', err);
    res.status(500).json({ error: err.message });
  }
}

// One service: deployed, only Cloud Scheduler may call it
async function scheduledRun(req: Request, res: Response) {
  if (config.isProduction && !(await verifySchedulerToken(req.get('authorization')))) return res.status(403).end();
  await fileInbox(res);
}

// The edge: Cloud Scheduler's token always (the edge has no development mode), then the app does the work. Anything
// but the app's summary is a failure Scheduler records (502); the logs say which step failed.
async function relayedRun(req: Request, res: Response) {
  if (!(await verifySchedulerToken(req.get('authorization')))) return res.status(403).end();
  const result = await relayCron();
  res.status(result.status).json(result.body);
}

// The app: only the relay as IAP signed it. The IAP check (iap.ts) lets no one else reach this path; checked again
// here should a route ever change.
async function relayedToApp(_req: Request, res: Response) {
  if ((res.locals.iap as IapPrincipal | undefined)?.principal !== 'relay') return res.status(403).end();
  await fileInbox(res);
}

export const cronHandler = (role: Role) => (role === 'edge' ? relayedRun : role === 'app' ? relayedToApp : scheduledRun);
