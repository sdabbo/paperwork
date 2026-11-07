// Documents by email. Forward a bill or send a scan to Paperwork's address and each attachment goes into the
// Inbox and is filed right away. An email without attachments (a booking confirmation, an online invoice)
// becomes a Google Doc of its own. When Paperwork runs as two services (roles.ts), mail reaches the public edge,
// which only puts it into the Inbox with its notes; the app files it on its next run (scheduled, or when opened).
//
// Mail reaches POST /inbound/email (inbound.ts) in one of two ways (see DEPLOY.md):
// - Cloudflare Email Routing with the worker in email-worker/, which posts the raw message (message/rfc822)
// - Postmark's inbound webhook, which posts JSON
// Both prove themselves with INBOUND_EMAIL_SECRET (Bearer token or Basic auth password), and only senders in
// INBOUND_ALLOWED_SENDERS (default: ALLOWED_EMAILS) or added in Settings are accepted.
import PostalMime from 'postal-mime';
import { Request } from 'express';
import { EmailSetup, EmailSetupChange, UploadResult } from '../shared/types.js';
import { logActivity } from './activity.js';
import { config } from './config.js';
import { sameSecret, sha256 } from './crypto.js';
import { htmlToText } from './extract.js';
import { addConvertedDoc, addFile, alreadyReceived, dropConvertedDoc, dropIntoInbox } from './pipeline.js';
import { getStore } from './store.js';

export interface InboundAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
  inline: boolean;
}

export interface InboundEmail {
  messageId: string;
  from: string;
  // Gmail's automatic forwarding keeps the original sender and names the forwarding account here
  forwardedFor: string[];
  fromName: string;
  subject: string;
  date: string | null;
  text: string;
  html: string | null;
  attachments: InboundAttachment[];
}

export function authorized(req: Request): boolean {
  const secret = config.inboundSecret;
  if (!secret) return false;
  const header = req.get('authorization') ?? '';
  if (header.startsWith('Bearer ') && sameSecret(header.slice(7).trim(), secret)) return true;
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (sameSecret(password, secret)) return true;
  }
  // Never in the address (?token=): addresses end up in logs
  return false;
}

const addresses = (value: string | undefined) => (value ?? '').toLowerCase().match(/[^\s,<>"]+@[^\s,<>"]+/g) ?? [];

const toBytes = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === 'string' ? new Uint8Array(Buffer.from(content, 'utf8')) : content instanceof Uint8Array ? content : new Uint8Array(content);

export async function parseRaw(raw: Uint8Array | string): Promise<InboundEmail> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const from = email.from && 'address' in email.from && email.from.address ? email.from : null;
  return {
    messageId: email.messageId || sha256(typeof raw === 'string' ? raw : Buffer.from(raw).toString('latin1')),
    from: (from?.address ?? '').toLowerCase(),
    forwardedFor: addresses(email.headers.find(h => h.key === 'x-forwarded-for')?.value),
    fromName: from?.name ?? '',
    subject: email.subject ?? '',
    date: email.date ?? null,
    text: email.text ?? (email.html ? htmlToText(email.html) : ''),
    html: email.html ?? null,
    attachments: email.attachments.map(a => ({
      filename: a.filename ?? '',
      mimeType: (a.mimeType || 'application/octet-stream').toLowerCase(),
      data: toBytes(a.content),
      inline: a.disposition === 'inline' || !!a.related,
    })),
  };
}

// Postmark's inbound JSON (https://postmarkapp.com/developer/webhooks/inbound-webhook)
export function parsePostmark(body: any): InboundEmail {
  const header = (name: string) =>
    (body.Headers as { Name: string; Value: string }[] | undefined)?.find(h => h.Name.toLowerCase() === name)?.Value;
  return {
    messageId: header('message-id') || body.MessageID || sha256(JSON.stringify(body)),
    from: String(body.FromFull?.Email ?? body.From ?? '').toLowerCase(),
    forwardedFor: addresses(header('x-forwarded-for')),
    fromName: String(body.FromFull?.Name ?? body.FromName ?? ''),
    subject: String(body.Subject ?? ''),
    date: body.Date ?? null,
    text: String(body.TextBody || (body.HtmlBody ? htmlToText(body.HtmlBody) : '')),
    html: body.HtmlBody || null,
    attachments: ((body.Attachments ?? []) as any[]).map(a => ({
      filename: String(a.Name ?? ''),
      mimeType: String(a.ContentType || 'application/octet-stream').toLowerCase(),
      data: new Uint8Array(Buffer.from(String(a.Content ?? ''), 'base64')),
      inline: !!a.ContentID,
    })),
  };
}

const SKIP_TYPES = /^(application\/(pkcs7-signature|x-pkcs7-signature|pgp-signature|pgp-keys|ms-tnef|ics)|text\/(calendar|vcard|x-vcard))/;
const SKIP_NAMES = /(\.(ics|vcf|p7s|asc|sig)$)|(^winmail\.dat$)/i;

// The attachments worth keeping: no signatures, calendar invites, or logos and icons from the email's design
export function documentsIn(email: InboundEmail): InboundAttachment[] {
  return email.attachments.filter(a => {
    if (SKIP_TYPES.test(a.mimeType) || SKIP_NAMES.test(a.filename)) return false;
    if (a.mimeType.startsWith('image/')) {
      if (a.data.byteLength < 20_000) return false;
      if (a.inline && a.data.byteLength < 100_000) return false;
    }
    return a.data.byteLength > 0;
  });
}

// For an attachment without a name: named by its type, so a Word file stays one (e.g. a contract's draft)
const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export interface ReceiveResult {
  status: 'added' | 'already-received' | 'sender-not-allowed' | 'nothing-to-add';
  results: UploadResult[];
}

export async function receiveEmail(email: InboundEmail): Promise<ReceiveResult> {
  const subject = email.subject.trim() || 'Email';
  const senders = await allowedSenders();
  if (!senders.has(email.from) && !email.forwardedFor.some(a => senders.has(a))) {
    await logActivity({ kind: 'rejected', name: subject, detail: `Email from ${email.from || 'an unknown sender'}, who is not allowed to send documents` });
    return { status: 'sender-not-allowed', results: [] };
  }

  // The public edge never files: it only puts the mail into the Inbox, for the app to file
  const edge = config.role === 'edge';
  const attachments = documentsIn(email);
  const mailId = sha256(email.messageId).slice(0, 24);
  // A message delivered again is recognised by its mailId. Not on the edge when it has attachments: one delivered
  // again after it failed part-way (Postmark tries again) still needs those it didn't add, and the edge adds none
  // twice (dropIntoInbox finds each one filed, kept or waiting by its checksum)
  if ((!edge || !attachments.length) && (await alreadyReceived(mailId))) return { status: 'already-received', results: [] };

  const sender = email.fromName ? `${email.fromName} <${email.from}>` : email.from;
  const notes = [`Email from ${sender}${email.date ? ` on ${email.date}` : ''}`, `Subject: ${subject}`, '', email.text.slice(0, 3000)].join('\n');
  const origin = `Email from ${email.from}: "${subject}"`;
  await logActivity({ kind: 'email', name: subject, detail: `From ${email.from}` });

  const results: UploadResult[] = [];
  for (const [i, a] of attachments.entries()) {
    const name = a.filename || `${subject}${attachments.length > 1 ? ` (${i + 1})` : ''}.${EXTENSIONS[a.mimeType] ?? 'bin'}`;
    const incoming = { name, mimeType: a.mimeType, data: a.data, source: 'email' as const, notes, origin, mailId };
    results.push(await (edge ? dropIntoInbox(incoming) : addFile(incoming)));
  }

  if (!attachments.length) {
    const body = email.html ?? (email.text ? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(email.text)}</pre>` : '');
    if (htmlToText(body).length < 20) return { status: 'nothing-to-add', results };
    const header = `<p><b>${escapeHtml(subject)}</b><br>${escapeHtml(sender)}${email.date ? `<br>${escapeHtml(email.date)}` : ''}</p><hr>`;
    const incoming = { name: subject, html: header + body, source: 'email' as const, notes, origin, mailId };
    results.push(await (edge ? dropConvertedDoc(incoming) : addConvertedDoc(incoming)));
  }
  return { status: 'added', results };
}

// ---------- Setup (Settings) ----------

// What was set in Settings: the address mail is forwarded to, and who else may send documents
interface StoredSetup {
  address?: string | null;
  senders?: string[];
}

const SETUP_KEY = 'email';
const MAX_SENDERS = 20;
const ADDRESS = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/;

export class SetupProblem extends Error {}

const storedSetup = async () => (await getStore().get<StoredSetup>(SETUP_KEY)) ?? {};

export async function allowedSenders(): Promise<Set<string>> {
  return new Set([...config.inboundSenders, ...((await storedSetup()).senders ?? [])]);
}

export async function inboundAddress(): Promise<string | null> {
  return (await storedSetup()).address || config.inboundAddress || null;
}

export async function emailSetup(): Promise<EmailSetup> {
  const stored = await storedSetup();
  const fixed = config.inboundSenders;
  const secret = config.inboundSecret || null;
  // The address mail services post to: the public edge's when Paperwork runs as two services
  let webhookUrl: string | null = null;
  if (secret) {
    const url = new URL('/inbound/email', config.publicUrl);
    url.username = 'inbound';
    url.password = secret;
    webhookUrl = url.href;
  }
  return {
    address: stored.address || config.inboundAddress || null,
    senders: [
      ...[...fixed].map(address => ({ address, fixed: true })),
      ...(stored.senders ?? []).filter(a => !fixed.has(a)).map(address => ({ address, fixed: false })),
    ],
    appUrl: config.publicUrl,
    secret,
    webhookUrl,
  };
}

function emailAddress(value: unknown, what: string): string {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ADDRESS.test(address) || address.length > 254) throw new SetupProblem(`${what} isn't an email address.`);
  return address;
}

// Changes what is given, keeps the rest. An empty address goes back to INBOUND_EMAIL_ADDRESS, if set.
export async function changeEmailSetup(change: EmailSetupChange): Promise<EmailSetup> {
  const next = { ...(await storedSetup()) };
  if (change.address !== undefined) {
    const address = typeof change.address === 'string' ? change.address.trim() : change.address;
    next.address = address === null || address === '' ? null : emailAddress(address, `“${address}”`);
  }
  if (change.senders !== undefined) {
    if (!Array.isArray(change.senders)) throw new SetupProblem('Senders must be a list.');
    const fixed = config.inboundSenders;
    const senders = [...new Set(change.senders.map(s => emailAddress(s, `“${s}”`)))].filter(s => !fixed.has(s));
    if (senders.length > MAX_SENDERS) throw new SetupProblem(`At most ${MAX_SENDERS} senders can be added.`);
    next.senders = senders;
  }
  await getStore().set<StoredSetup>(SETUP_KEY, next);
  return emailSetup();
}
