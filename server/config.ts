// Settings from the environment (.env locally, deploy/deploy.sh on Cloud Run). Read on use rather than at
// import, so tests can change them.

const list = (value: string | undefined) =>
  (value || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);

// Which part of Paperwork this process serves (server/app.ts). 'all' (PAPERWORK_ROLE unset): everything, as one
// service. 'app': the owner's app behind Google's Identity-Aware Proxy. 'edge': the public doors only (AI apps'
// MCP and OAuth, forwarded email, Cloud Scheduler), never filing or writing the index.
export type Role = 'all' | 'app' | 'edge';

export const config = {
  // Cloud Run always sets K_SERVICE, so a deploy that lost NODE_ENV still runs with every production check
  get isProduction() {
    return process.env.NODE_ENV === 'production' || !!process.env.K_SERVICE;
  },
  get port() {
    return Number(process.env.PORT) || 3000;
  },
  get role(): Role {
    const role = process.env.PAPERWORK_ROLE ?? '';
    if (role === '' || role === 'all') return 'all';
    if (role === 'app' || role === 'edge') return role;
    // The server refuses to start with it (roles.ts configProblems)
    throw new Error(`PAPERWORK_ROLE must be app, edge or all, not "${role}".`);
  },
  // The owner's app: sign-in, links to documents
  get appUrl() {
    return (process.env.APP_URL || `http://localhost:${this.port}`).replace(/\/+$/, '');
  },
  // The address AI apps and mail services use (the edge when Paperwork runs as two services); the app's otherwise
  get publicUrl() {
    return (process.env.PUBLIC_URL || this.appUrl).replace(/\/+$/, '');
  },
  // What IAP's signed header must be issued for (role app): /projects/NUMBER/locations/REGION/services/SERVICE
  get iapAudience() {
    return process.env.IAP_AUDIENCE || '';
  },
  // The edge's service account: the only identity the app accepts on /internal/cron, and the one the edge signs as
  get cronRelayAccount() {
    return (process.env.CRON_RELAY_ACCOUNT || '').trim().toLowerCase();
  },
  get cronRelayAudience() {
    return process.env.CRON_RELAY_AUDIENCE || `${this.appUrl}/internal/cron`;
  },
  // Finance's service account (the owner's finance app, role app): the only identity let in on the read-only feed,
  // GET /internal/finance/contracts and /purchases (iap.ts, finance.ts). Unset: the feed is off. Compared with
  // IAP's signed address, which is lower case.
  get financeReaderAccount() {
    return (process.env.FINANCE_READER_ACCOUNT || '').trim().toLowerCase();
  },
  // Google accounts that may sign in. Deploys refuse to run without it.
  get allowedEmails() {
    return new Set(list(process.env.ALLOWED_EMAILS));
  },
  get googleClientId() {
    return process.env.GOOGLE_CLIENT_ID || '';
  },
  get googleClientSecret() {
    return process.env.GOOGLE_CLIENT_SECRET || '';
  },
  // app (default): Google's narrow "drive.file" permission: only files Paperwork created itself (uploads in the
  // app, forwarded emails) and files the owner picks in Google's file picker (e.g. scans made with the Drive app).
  // full: Google's "drive" permission, so files the Drive app's scanner (or anyone) puts into the Inbox are seen
  // without picking them. Either way, server/drive.ts refuses to delete, trash, share or overwrite anything.
  get driveAccess(): 'full' | 'app' {
    return process.env.DRIVE_ACCESS === 'full' ? 'full' : 'app';
  },
  // Browser key for Google's file picker, limited to the Picker API and Paperwork's pages (deploy/setup.sh)
  get pickerApiKey() {
    return process.env.PICKER_API_KEY || '';
  },
  // The Google Cloud project the sign-in client belongs to: its number starts the client ID. The picker grants
  // Paperwork access to picked files through it.
  get pickerAppId() {
    return /^(\d+)-/.exec(process.env.GOOGLE_CLIENT_ID || '')?.[1] ?? '';
  },
  // Language of folder names, titles and summaries
  get language(): 'en' | 'de' {
    return process.env.APP_LANGUAGE === 'de' ? 'de' : 'en';
  },
  get rootFolderName() {
    return process.env.DRIVE_FOLDER_NAME || 'Paperwork';
  },
  get timezone() {
    return process.env.TZ || 'Europe/Berlin';
  },
  // Forwarded email (see server/email.ts and email-worker/)
  get inboundSecret() {
    return process.env.INBOUND_EMAIL_SECRET || '';
  },
  get inboundAddress() {
    return process.env.INBOUND_EMAIL_ADDRESS || '';
  },
  // Who may send documents by email; defaults to the accounts that may sign in
  get inboundSenders() {
    const senders = list(process.env.INBOUND_ALLOWED_SENDERS);
    return new Set(senders.length ? senders : list(process.env.ALLOWED_EMAILS));
  },
};

// Today where the household lives, YYYY-MM-DD
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
