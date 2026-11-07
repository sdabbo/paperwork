// Finance's read-only feed. Finance, the owner's finance app, matches the payments in their bank accounts with the
// contracts Paperwork knows (and, later, purchases with receipts). It calls the app behind IAP as its own service
// account, which iap.ts lets through to exactly GET on the two paths below and nowhere else; this router checks that
// principal again before anything else.
//
// What the feed may and may not do:
// - It only reads: the in-memory index and the store. Nothing here calls Gemini, Drive or Google, and the contracts
//   are taken as last read (`contracts(false)`): the feed never makes Paperwork read topics again, so it spends no AI
//   budget. Finance can change nothing through it.
// - Every field is mapped one by one, never by spreading a DocumentInfo or a Contract, so a field added to those
//   later (a summary, the text, a Drive link, the folders) never reaches Finance by itself.
// - Numbers that look like an IBAN or a card are masked here (maskNumbers): "only the last 4 digits" is something
//   Gemini is asked to write, not something it is held to.
// - Receipts from a doctor, a pharmacy or the like come without their titles and item names (GDPR Art. 9).
import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import { possibleCopies } from '../shared/filter.js';
import { documentPath, topicPagePath } from '../shared/paths.js';
import { Contract, ContractInterval, ContractKind, ContractStatus, DocumentInfo, DocumentType, NoticePeriod } from '../shared/types.js';
import { config, today } from './config.js';
import { contracts, docDay, topicGroups } from './contracts.js';
import { getIndex } from './docIndex.js';
import { toInfo } from './indexing.js';

// Documents listed per contract: the ones its terms come from first, then the newest
const MAX_DOCUMENTS = 20;
// Reference numbers per contract, taken from its newest documents, each cut to a length
const REFERENCE_DOCUMENTS = 20;
const MAX_REFERENCES = 30;
const REFERENCE_LENGTH = 120;
// Receipts per answer, and the longest range Finance may ask for at once
const MAX_RECEIPTS = 2000;
const MAX_DAYS = 400;

export interface FeedDocument {
  id: string;
  title: string;
  date: string;
  type: DocumentType | null;
  amount: number | null;
  currency: string | null;
  checked: boolean;
  url: string;
}

export interface FeedContract {
  // The first 16 hex characters of sha1(topic): stable while the topic keeps its name
  key: string;
  topic: string;
  name: string;
  kind: ContractKind;
  provider: string | null;
  reference: string | null;
  // The reference numbers of the topic's documents ("Policy: KH-4471-2290")
  references: string[];
  amount: number | null;
  currency: string | null;
  interval: ContractInterval | null;
  yearly: number | null;
  since: string | null;
  renewal: 'year' | 'month' | null;
  renews: string | null;
  notice: string | null;
  noticePeriod: NoticePeriod | null;
  cancelBy: string | null;
  status: ContractStatus;
  endsOn: string | null;
  // A sentence ("Premium for 2027 rises to 642.18 EUR"), not an amount
  latest: string | null;
  url: string;
  documents: FeedDocument[];
}

export interface FeedContracts {
  version: 1;
  today: string;
  pending: number;
  problem: string | null;
  contracts: FeedContract[];
}

export interface FeedItem {
  // Where it stands on the receipt, from 0
  line: number;
  name: string | null;
  details: string | null;
  quantity: number;
  price: number | null;
  code: string | null;
}

export interface FeedReceipt {
  id: string;
  url: string;
  title: string | null;
  store: string | null;
  date: string;
  type: DocumentType | null;
  total: number | null;
  currency: string | null;
  checked: boolean;
  modifiedAt: string;
  // The items don't add up to the total: Paperwork keeps at most 25 and leaves out deposits and discounts
  capped: boolean;
  items: FeedItem[];
}

export interface FeedPurchases {
  version: 1;
  today: string;
  since: string;
  until: string;
  receipts: FeedReceipt[];
}

// Paperwork's index is empty (it just started on an emptied database, or is being rebuilt): Finance tries again later
class IndexEmpty extends Error {}
// The query isn't what the feed takes
class BadRequest extends Error {}

const log = (severity: 'INFO' | 'WARNING' | 'ERROR', message: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ severity, message, ...fields }));

// ---------- Masking ----------

// The space between groups: any run of white space. Besides a plain space, a document's text (a PDF written in a word
// processor) may hold no-break, narrow, thin or figure spaces, which Gemini copies as they are, and a number pasted
// from a PDF or copied from a laid-out statement may hold two spaces, a tab or a line break between its groups.
const SPACE = '\\s+';
// Two capital letters and two digits, then 11 to 30 capitals or digits written together, or in groups of four
// separated by white space. Case-sensitive and grouped by four, so ordinary words after something like "ab01" are
// never taken for one; no checksum, so a mistyped IBAN is masked too.
const IBAN = new RegExp(`\\b[A-Z]{2}\\d{2}(?:[A-Z0-9]{11,30}|(?:${SPACE}[A-Z0-9]{4}){2,7}(?:${SPACE}[A-Z0-9]{1,4})?)\\b`, 'g');
// The same with digits only after the check digits, grouped any other way ("DE89 37040044 0532013000",
// "DE893704 0044 …"): a German IBAN is all digits. Only digits, so no word is ever taken for part of one. Each group
// after the first starts at white space, so a long run of digits can be read only one way: written as "(space? digits)+"
// it could be split anywhere, and a long run with a letter right after it took seconds to give up on.
const IBAN_DIGITS = new RegExp(`\\b[A-Z]{2}\\d{2}\\d*(?:${SPACE}\\d+)*\\b`, 'g');
const IBAN_DIGITS_MIN = 11;
// Groups of digits separated by white space or dashes ("4111 1111 1111 1111", "4111-1111-…", or one run)
const DIGIT_GROUPS = new RegExp(`\\d+(?:(?:${SPACE}|-)\\d+)*`, 'g');
const SEPARATOR = new RegExp(`(${SPACE}|-)`);

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// A card number among groups of digits: the longest stretch of whole groups with 13 to 19 digits that passes the
// Luhn check, as "•••• 1234"; then the same for what is left on either side (a date or a second card next to it)
function maskCards(run: string): string {
  // Groups at even indexes, the separators between them at odd ones
  const parts = run.split(SEPARATOR);
  const groups = parts.filter((_, i) => i % 2 === 0);
  let best: { from: number; to: number; length: number } | null = null;
  for (let from = 0; from < groups.length; from++) {
    let digits = '';
    for (let to = from; to < groups.length && digits.length + groups[to].length <= 19; to++) {
      digits += groups[to];
      if (digits.length >= 13 && (!best || digits.length > best.length) && luhn(digits)) best = { from, to, length: digits.length };
    }
  }
  if (!best) return run;
  const last4 = groups
    .slice(best.from, best.to + 1)
    .join('')
    .slice(-4);
  return `${maskCards(parts.slice(0, 2 * best.from).join(''))}•••• ${last4}${maskCards(parts.slice(2 * best.to + 1).join(''))}`;
}

// IBANs as "DE89 … 3000" (their first four characters and their last four letters and digits, as Finance shows its
// own) and card numbers as "•••• 1234". A long contract number that happens to pass the Luhn check is masked too,
// which only costs Finance a match by that number.
const maskIban = (iban: string) => `${iban.slice(0, 4)} … ${iban.replace(/[^A-Z0-9]/g, '').slice(-4)}`;

export function maskNumbers(text: string): string {
  return text
    .replace(IBAN, maskIban)
    .replace(IBAN_DIGITS, iban => (iban.slice(4).replace(/\D/g, '').length >= IBAN_DIGITS_MIN ? maskIban(iban) : iban))
    .replace(DIGIT_GROUPS, maskCards);
}

const masked = (text: string | null) => (text === null ? null : maskNumbers(text));

// ---------- Health receipts ----------

// Words of a store that make its receipts health data. Parts of words, not whole words, because German joins them
// ("Hausarztpraxis", "Augenoptik", "Physiotherapiepraxis", "Shop-Apotheke"); a store wrongly taken for one only loses
// its item names. A pharmacy's till receipt is usually filed under Bills & Receipts, so the folder alone misses it.
export const HEALTH_PARTS = ['apothek', 'pharma', 'docmorris', 'medpex', 'arzt', 'aerzt', 'klinik', 'krankenhaus', 'physio', 'therap', 'optik', 'akustik', 'sanitaet', 'orthop', 'zahnmedizin', 'dental'];
// Too short or too common to look for inside other words ("Praxisbedarf" is a shop for surgeries)
const HEALTH_WORDS = ['praxis', 'labor', 'mvz'];
// The Health folder as Paperwork names it in English and German (categories.ts, not imported here: the feed keeps to
// the index and the store)
const HEALTH_FOLDERS = ['health', 'gesundheit'];

const foldGerman = (text: string) => text.normalize('NFC').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

export function isHealth(d: DocumentInfo): boolean {
  if (d.type === 'medical') return true;
  if ([d.category, d.folderPath?.[0]].some(name => !!name && HEALTH_FOLDERS.includes(name.trim().toLowerCase()))) return true;
  const words = foldGerman(d.correspondent ?? '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some(word => HEALTH_WORDS.includes(word) || HEALTH_PARTS.some(part => word.includes(part)));
}

// ---------- The answers ----------

const link = (path: string) => `${config.appUrl}${path}`;
// Index entries from before items were read have none
const itemsOf = (d: DocumentInfo) => d.items ?? [];
const newestFirst = (a: DocumentInfo, b: DocumentInfo) => docDay(b).localeCompare(docDay(a)) || a.id.localeCompare(b.id);

async function indexed(): Promise<DocumentInfo[]> {
  const docs = await getIndex().all();
  if (!docs.length) throw new IndexEmpty();
  return docs.map(toInfo);
}

function feedDocument(d: DocumentInfo): FeedDocument {
  return {
    id: d.id,
    title: maskNumbers(d.title),
    date: docDay(d),
    type: d.type,
    amount: d.amount,
    currency: d.currency,
    checked: !d.needsReview,
    url: link(documentPath(d.id)),
  };
}

// The reference numbers of a topic's newest documents: each document's "Label: value" pairs joined with " · "
function referencesOf(docs: DocumentInfo[]): string[] {
  const found = new Set<string>();
  for (const d of [...docs].sort(newestFirst).slice(0, REFERENCE_DOCUMENTS)) {
    for (const part of (d.references ?? '').split(' · ')) {
      // Masked before it is cut, so a cut never leaves part of an IBAN in clear
      const reference = maskNumbers(part.trim()).slice(0, REFERENCE_LENGTH).trim();
      if (reference) found.add(reference);
    }
  }
  return [...found].slice(0, MAX_REFERENCES);
}

function feedContract(c: Contract, docs: DocumentInfo[]): FeedContract {
  const topic = maskNumbers(c.topic);
  const byId = new Map(docs.map(d => [d.id, d]));
  const telling = c.documentIds.map(id => byId.get(id)).filter((d): d is DocumentInfo => !!d);
  const others = docs.filter(d => !c.documentIds.includes(d.id)).sort(newestFirst);
  return {
    key: crypto.createHash('sha1').update(c.topic).digest('hex').slice(0, 16),
    topic,
    name: maskNumbers(c.name),
    kind: c.kind,
    provider: masked(c.provider),
    reference: masked(c.reference),
    references: referencesOf(docs),
    amount: c.amount,
    currency: c.currency,
    interval: c.interval,
    yearly: c.yearly,
    since: c.since,
    renewal: c.renewal,
    renews: c.renews,
    notice: masked(c.notice),
    noticePeriod: c.noticePeriod ? { count: c.noticePeriod.count, unit: c.noticePeriod.unit } : null,
    cancelBy: c.cancelBy,
    status: c.status,
    endsOn: c.endsOn,
    latest: masked(c.latest),
    // The topic's page carries the topic in its path: when the mask hid part of it, the link would hand that over,
    // so it is Paperwork's Contracts page instead
    url: link(topic === c.topic ? topicPagePath(c.topic) : '/contracts'),
    documents: [...telling, ...others].slice(0, MAX_DOCUMENTS).map(feedDocument),
  };
}

export async function contractsFeed(now = today()): Promise<FeedContracts> {
  const groups = topicGroups(await indexed());
  const listed = await contracts(false, now);
  return {
    version: 1,
    today: now,
    pending: listed.pending,
    problem: masked(listed.problem),
    contracts: listed.contracts.map(c => feedContract(c, groups.get(c.topic) ?? [])),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDay(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return DAY.test(value) && !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// since (required) and until (optional, default today), each once, real days, at most MAX_DAYS apart; nothing else
function rangeOf(query: string, now: string): { since: string; until: string } {
  const params = new URLSearchParams(query);
  if ([...params.keys()].some(name => name !== 'since' && name !== 'until')) throw new BadRequest();
  const since = params.getAll('since');
  const until = params.getAll('until');
  if (since.length !== 1 || until.length > 1) throw new BadRequest();
  const range = { since: since[0], until: until[0] ?? now };
  if (!validDay(range.since) || !validDay(range.until) || range.until < range.since || daysBetween(range.since, range.until) > MAX_DAYS) throw new BadRequest();
  return range;
}

const cents = (amount: number) => Math.round(amount * 100);

export function capped(d: DocumentInfo): boolean {
  const items = itemsOf(d);
  if (d.amount === null || items.some(i => i.price === null)) return true;
  return Math.abs(items.reduce((sum, i) => sum + cents(i.price!), 0) - cents(d.amount)) > 1;
}

function feedReceipt(d: DocumentInfo): FeedReceipt {
  const health = isHealth(d);
  return {
    id: d.id,
    url: link(documentPath(d.id)),
    // Titles name medicines and doctors
    title: health ? null : maskNumbers(d.title),
    store: masked(d.correspondent),
    date: docDay(d),
    type: d.type,
    total: d.amount,
    currency: d.currency,
    checked: !d.needsReview,
    modifiedAt: d.modifiedAt,
    capped: capped(d),
    items: itemsOf(d).map((item, line) => ({
      line,
      name: health ? null : maskNumbers(item.name),
      details: health ? null : masked(item.details),
      quantity: item.quantity,
      price: item.price,
      code: health ? null : item.code,
    })),
  };
}

export async function purchasesFeed(query: string, now = today()): Promise<FeedPurchases> {
  const { since, until } = rangeOf(query, now);
  const docs = await indexed();
  const copies = possibleCopies(docs);
  const receipts = docs
    .filter(d => (itemsOf(d).length > 0 || d.type === 'receipt') && !copies.has(d.id) && docDay(d) >= since && docDay(d) <= until)
    .sort(newestFirst)
    .slice(0, MAX_RECEIPTS)
    .map(feedReceipt);
  return { version: 1, today: now, since, until, receipts };
}

// ---------- The router (app.ts mounts it at /internal/finance for role app, once FINANCE_READER_ACCOUNT is set) ----------

const queryOf = (req: Request) => {
  const at = req.originalUrl.indexOf('?');
  return at < 0 ? '' : req.originalUrl.slice(at + 1);
};
const pathOf = (req: Request) => req.originalUrl.split('?')[0];

export const financeRouter = express.Router({ caseSensitive: true, strict: true });

financeRouter.use((req, res, next) => {
  // iap.ts lets only Finance's account through to these paths; should a change there ever let anyone else in, this
  // still refuses them
  if (res.locals.iap?.principal !== 'finance') {
    log('WARNING', 'Finance feed refused', { path: pathOf(req), principal: res.locals.iap?.principal ?? null });
    return res.status(403).set('Cache-Control', 'no-store').type('text/plain').send('Forbidden');
  }
  res.set('Cache-Control', 'no-store');
  const started = Date.now();
  // One line per request: what was asked and how many came back, never what
  res.on('finish', () => log('INFO', 'Finance feed served', { path: pathOf(req), status: res.statusCode, count: res.locals.feedCount ?? 0, ms: Date.now() - started }));
  next();
});

financeRouter.get('/contracts', async (req, res) => {
  if (queryOf(req)) throw new BadRequest();
  const feed = await contractsFeed();
  res.locals.feedCount = feed.contracts.length;
  res.json(feed);
});

financeRouter.get('/purchases', async (req, res) => {
  const feed = await purchasesFeed(queryOf(req));
  res.locals.feedCount = feed.receipts.length;
  res.json(feed);
});

// Nothing else is here
financeRouter.use((_req, res) => {
  res.status(404).end();
});

financeRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof IndexEmpty) return res.status(503).set('Retry-After', '30').json({ error: 'index-empty' });
  if (err instanceof BadRequest) return res.status(400).json({ error: 'bad-request' });
  // The error's name only: a message may quote what was being read
  log('ERROR', 'Finance feed failed', { error: err instanceof Error ? err.name : typeof err });
  res.status(500).json({ error: 'failed' });
});
