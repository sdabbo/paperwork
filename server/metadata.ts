// What Paperwork knows about a document, and how it is written onto the file in Drive:
// - the file name: "2025-03-14 Stadtwerke Musterstadt - Electricity bill March.pdf"
// - the description (shown in Drive's file details and found by Drive's search): summary and key facts
// - properties: Drive's key/value labels on a file, for the fields the app filters on. Google allows 124
//   bytes per key and value together, so long values are shortened there (the description keeps them whole).
import crypto from 'crypto';
import { DOCUMENT_TYPES, Deadline, DeadlineKind, DocumentSource, DocumentType, PurchaseItem, isDocumentType } from '../shared/types.js';
import { MAX_NAME, clean, cleanLabel, extensionOf, keptLabel, keptName } from '../shared/names.js';
import { config } from './config.js';

export interface DocMeta {
  title: string;
  type: DocumentType | null;
  correspondent: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  dueDate: string | null;
  // All of them are listed in the description; properties hold only dueDate, the main one. The full list,
  // with what is done, lives in the search index.
  deadlines: Deadline[];
  // What was bought, for a till receipt or a shop's invoice; listed in the description
  items: PurchaseItem[];
  tags: string[];
  references: string | null;
  action: string | null;
  summary: string;
  // The contract, policy, account or case it belongs to, and one line for that topic's timeline
  topic: string | null;
  gist: string | null;
  needsReview: boolean;
  confidence: number | null;
}

// Marks a file as a document Paperwork filed; folders carry 'root', 'inbox', 'duplicates' or 'category', and a
// file kept with a document (attachments.ts) carries 'attachment'
export const ROLE = 'paperwork';
// 2: with topic and gist. Documents filed before are given them in the background (sync.ts fillTopics). (The
// items bought have a mark of their own, P.itemsRead.)
export const SCHEMA_VERSION = '2';
export const TOPICS_VERSION = 2;
const PROPERTY_BYTES = 124;

export const P = {
  title: 'pwTitle',
  type: 'pwType',
  correspondent: 'pwFrom',
  date: 'pwDate',
  amount: 'pwAmount',
  currency: 'pwCur',
  dueDate: 'pwDue',
  tags: 'pwTags',
  references: 'pwRef',
  action: 'pwTodo',
  topic: 'pwTopic',
  // The items bought were looked for ('1'): filed since Paperwork reads them, or read for it later (pipeline.ts
  // fillItems)
  itemsRead: 'pwItems',
  review: 'pwReview',
  // A document waiting in the Inbox for its check: the category folder it goes to once checked
  target: 'pwCat',
  confidence: 'pwConf',
  source: 'pwSource',
  md5: 'pwMd5',
  mail: 'pwMail',
  nameHash: 'pwName',
  // How it arrived, e.g. 'Email from anna@example.com: "Your invoice"'
  origin: 'pwOrigin',
  version: 'pwV',
  // Inbox bookkeeping
  state: 'pwState',
  error: 'pwError',
  tries: 'pwTries',
  // Added to a folder by the owner ("Add a document to this folder"): that folder, until the file is filed there
  into: 'pwInto',
  duplicateOf: 'pwDupOf',
  // A file kept with a document: that document's ID, and what the file is ("Draft")
  of: 'pwOf',
  label: 'pwLabel',
  // A document that may be a copy of another one (duplicates.ts): that one's ID, until the owner decides. Never in
  // toProperties, so edits keep it.
  maybeDup: 'pwMaybeDup',
  // The documents the owner said this one is no copy of ("Keep both"): short hashes of their IDs (dupTag),
  // comma-separated
  notDup: 'pwNotDup',
} as const;

// ---------- Possible duplicates ----------

// A document's ID as the "Keep both" answers keep it: short, so a dozen fit into one Drive label
export const dupTag = (id: string) => crypto.createHash('sha1').update(id).digest('base64url').slice(0, 8);
export const MAX_NOT_DUP = 12;

export const parseDupTags = (value: string | undefined): string[] => (value ?? '').split(',').filter(t => /^[A-Za-z0-9_-]{8}$/.test(t));

// The answers with the one for `id` added (once), the oldest dropped beyond MAX_NOT_DUP. Never cut with fit(), which
// would break a tag.
export function addDupTag(value: string | undefined, id: string): string {
  const tag = dupTag(id);
  return [...parseDupTags(value).filter(t => t !== tag), tag].slice(-MAX_NOT_DUP).join(',');
}

// Cuts a value so key and value fit Google's limit, at a character boundary
export function fit(key: string, value: string): string {
  const room = PROPERTY_BYTES - Buffer.byteLength(key);
  if (Buffer.byteLength(value) <= room) return value;
  let out = '';
  for (const ch of value) {
    if (Buffer.byteLength(out + ch + '…') > room) break;
    out += ch;
  }
  return out + '…';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

export const nameHash = (name: string) => crypto.createHash('sha1').update(name).digest('hex').slice(0, 12);

// Properties for a filed document. Empty fields are removed (null) so an edit can clear them. `version` is
// SCHEMA_VERSION unless an edit leaves a document's topic and gist to be worked out later, and `itemsRead` true
// unless it leaves the items bought to be read later.
export function toProperties(meta: DocMeta, fileName: string, version = SCHEMA_VERSION, itemsRead = true): Record<string, string | null> {
  const props: Record<string, string | null> = {
    [ROLE]: 'doc',
    [P.version]: version,
    [P.title]: fit(P.title, meta.title),
    [P.type]: meta.type,
    [P.correspondent]: meta.correspondent ? fit(P.correspondent, meta.correspondent) : null,
    [P.date]: meta.date,
    [P.amount]: meta.amount === null ? null : String(meta.amount),
    [P.currency]: meta.currency,
    [P.dueDate]: meta.dueDate,
    [P.tags]: meta.tags.length ? fit(P.tags, meta.tags.join(',')) : null,
    [P.references]: meta.references ? fit(P.references, meta.references) : null,
    [P.action]: meta.action ? fit(P.action, meta.action) : null,
    [P.topic]: meta.topic ? fit(P.topic, meta.topic) : null,
    [P.itemsRead]: itemsRead ? '1' : null,
    [P.review]: meta.needsReview ? '1' : null,
    [P.confidence]: meta.confidence === null ? null : meta.confidence.toFixed(2),
    [P.nameHash]: nameHash(fileName),
    // A filed document is out of the Inbox's bookkeeping
    [P.state]: null,
    [P.error]: null,
    [P.tries]: null,
  };
  return props;
}

export function fromProperties(props: Record<string, string> = {}, description = ''): DocMeta {
  const amount = props[P.amount] !== undefined ? Number(props[P.amount]) : NaN;
  const confidence = props[P.confidence] !== undefined ? Number(props[P.confidence]) : NaN;
  const dueDate = validDate(props[P.dueDate]);
  const deadlines = deadlinesFrom(description, props[P.action]);
  return {
    title: props[P.title] || '',
    type: isDocumentType(props[P.type]) ? (props[P.type] as DocumentType) : null,
    correspondent: props[P.correspondent] || null,
    date: validDate(props[P.date]),
    amount: Number.isFinite(amount) ? amount : null,
    currency: props[P.currency] || null,
    dueDate,
    deadlines: deadlines.length ? deadlines : dueDate ? [{ date: dueDate, what: props[P.action] || 'Due', done: false }] : [],
    items: itemsFrom(description),
    tags: props[P.tags] ? props[P.tags].split(',').map(t => t.trim()).filter(Boolean) : [],
    references: props[P.references] || null,
    action: props[P.action] || null,
    summary: summaryFrom(description),
    // The description has them whole; the label only a shortened topic
    topic: factFrom(description, TOPIC_LABEL) ?? (props[P.topic] || null),
    gist: factFrom(description, GIST_LABEL),
    needsReview: props[P.review] === '1',
    confidence: Number.isFinite(confidence) ? confidence : null,
  };
}

export function sourceOf(props: Record<string, string> = {}): DocumentSource | null {
  const source = props[P.source];
  return source === 'email' || source === 'upload' || source === 'drive' ? source : null;
}

// ---------- File name ----------

// The rules for names, shared with the app (shared/names.ts)
export { clean, cleanLabel, extensionOf };

export function fileName(meta: Pick<DocMeta, 'title' | 'date' | 'correspondent'>, original: { name: string; mimeType: string }): string {
  const ext = extensionOf(original.name, original.mimeType);
  const parts = [meta.date, meta.correspondent ? clean(meta.correspondent) : null].filter(Boolean).join(' ');
  const title = clean(meta.title) || clean(original.name.replace(/\.[^.]+$/, '')) || 'Document';
  let base = parts ? `${parts} - ${title}` : title;
  if (base.length > MAX_NAME - ext.length) base = base.slice(0, MAX_NAME - ext.length - 1).trimEnd() + '…';
  return base + ext;
}

// ---------- Files kept with a document ----------

// What a kept file is, by its extension, in the app's language
export const attachmentLabel = (file: { name: string; mimeType: string }): string => keptLabel(file, config.language);

// What a copy of a document kept with it is ("Keep it with the original": the paper scan next to the emailed PDF)
export const copyLabel = () => (config.language === 'de' ? 'Kopie' : 'Copy');

// A kept file's name: its document's name with the label ("2026-10-20 Example UG - Loan agreement - Draft.docx")
export const attachmentName = (
  document: { name: string; mimeType: string },
  file: { name: string; mimeType: string },
  label = attachmentLabel(file),
  taken: string[] = []
): string => keptName(document, file, label, taken);

// ---------- Description ----------

// Separates the summary (which the app shows and edits) from the facts below it
const FACTS_MARK = '\n\n———\n';
const TOPIC_LABEL = 'Topic: ';
const GIST_LABEL = 'Update: ';

// A one-line fact from the description ("Topic: Car insurance VW Golf")
function factFrom(description: string, label: string): string | null {
  const at = description.indexOf(FACTS_MARK);
  if (at < 0) return null;
  const line = description.slice(at + FACTS_MARK.length).split('\n').find(l => l.startsWith(label));
  return line?.slice(label.length).trim() || null;
}

// One line, as a topic or gist is written into the description's facts
export const oneLine = (value: unknown, max: number): string | null =>
  (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;

const money = (amount: number, currency: string | null) =>
  `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;

export function describe(meta: DocMeta, origin?: string | null): string {
  const headline = [
    meta.type ? DOCUMENT_TYPES[meta.type] : null,
    meta.correspondent,
    meta.date,
    meta.amount !== null ? money(meta.amount, meta.currency) : null,
  ].filter(Boolean);
  const dates: Pick<Deadline, 'date' | 'what' | 'kind'>[] = meta.deadlines.length ? meta.deadlines : meta.dueDate ? [{ date: meta.dueDate, what: 'Due' }] : [];
  const kind = (d: Pick<Deadline, 'kind'>) => (d.kind ? ` [${d.kind}]` : '');
  const lines = [
    headline.join(' · '),
    meta.topic ? `${TOPIC_LABEL}${meta.topic}` : null,
    meta.gist ? `${GIST_LABEL}${meta.gist}` : null,
    ...meta.items.slice(0, MAX_ITEMS).map(i => itemLine(i, meta.currency)),
    dates.length === 1 ? `Due: ${dates[0].date}${dates[0].what !== 'Due' ? ` (${dates[0].what})` : ''}${kind(dates[0])}` : null,
    dates.length > 1 ? `Dates: ${dates.map(d => `${d.date} ${d.what}${kind(d)}`).join(' · ')}` : null,
    meta.references ? `Reference: ${meta.references}` : null,
    meta.action ? `To do: ${meta.action}` : null,
    meta.tags.length ? `Tags: ${meta.tags.map(t => `#${t.replace(/\s+/g, '-')}`).join(' ')}` : null,
    origin ? `Arrived as: ${origin}` : null,
    'Filed by Paperwork',
  ].filter(Boolean);
  return `${meta.summary.trim()}${FACTS_MARK}${lines.join('\n')}`;
}

// A deadline's description, fit for the facts line it is written into ("Dates: 2025-03-01 Pay · …")
export const deadlineText = (value: unknown, max = 120): string =>
  (typeof value === 'string' ? value : '')
    .replace(/\s+/g, ' ')
    .replace(/\s*·\s*/g, ', ')
    // Brackets end a line's deadline with its kind ("[return]")
    .replace(/[[\]]/g, '')
    .trim()
    .slice(0, max);

// The deadlines written into the description's facts ("Due: …" or "Dates: … · …"), so an index rebuilt from
// Drive gets them all back (which ones were done is known to the index only)
export function deadlinesFrom(description: string, dueWhat?: string): Deadline[] {
  const at = description.indexOf(FACTS_MARK);
  if (at < 0) return [];
  const facts = description.slice(at + FACTS_MARK.length).split('\n');
  const list: Deadline[] = [];
  const withKind = (deadline: Deadline, kind: string | undefined): Deadline => (isDeadlineKind(kind) ? { ...deadline, kind } : deadline);
  for (const line of facts) {
    const due = /^Due: (\d{4}-\d{2}-\d{2})(?: \((.+?)\))?(?: \[(\w+)\])?$/.exec(line);
    if (due && validDate(due[1])) list.push(withKind({ date: due[1], what: due[2] || dueWhat || 'Due', done: false }, due[3]));
    if (line.startsWith('Dates: ')) {
      for (const part of line.slice('Dates: '.length).split(' · ')) {
        const m = /^(\d{4}-\d{2}-\d{2}) (.+?)(?: \[(\w+)\])?$/.exec(part.trim());
        if (m && validDate(m[1])) list.push(withKind({ date: m[1], what: m[2], done: false }, m[3]));
      }
    }
  }
  return list;
}

export const isDeadlineKind = (value: unknown): value is DeadlineKind => value === 'return' || value === 'warranty';

// ---------- Items bought ----------

// Items listed per document; a long grocery receipt keeps its most expensive ones (the model is asked for those)
export const MAX_ITEMS = 25;
const ITEM_LABEL = 'Item: ';

// One item as written into the description: "Item: 1 × Arc'teryx Beta SV Jacket | Size S, Tatsu | 679.99 EUR | 0623555816737"
function itemLine(item: PurchaseItem, currency: string | null): string {
  const price = item.price === null ? '' : `${item.price.toFixed(2)}${currency ? ` ${currency}` : ''}`;
  return `${ITEM_LABEL}${item.quantity} × ${item.name} | ${item.details ?? ''} | ${price} | ${item.code ?? ''}`;
}

export function itemsFrom(description: string): PurchaseItem[] {
  const at = description.indexOf(FACTS_MARK);
  if (at < 0) return [];
  const items: PurchaseItem[] = [];
  for (const line of description.slice(at + FACTS_MARK.length).split('\n')) {
    const m = /^Item: (\d+) × (.+?) \| (.*?) \| (.*?) \| (.*)$/.exec(line);
    if (!m) continue;
    const price = /^-?\d+(?:\.\d+)?/.exec(m[4].trim())?.[0];
    items.push({ name: m[2].trim(), details: m[3].trim() || null, quantity: Number(m[1]) || 1, price: price === undefined ? null : Number(price), code: m[5].trim() || null });
  }
  return items;
}

// A text for an item's field: one line, without the separator the description uses
const itemText = (value: unknown, max: number): string | null => oneLine(typeof value === 'string' ? value.replace(/\|/g, '/') : value, max);

// Items as the model gives them or the app sends them: named, a whole quantity of at least one, prices rounded
export function cleanItems(raw: unknown): PurchaseItem[] {
  if (!Array.isArray(raw)) return [];
  const items: PurchaseItem[] = [];
  for (const r of raw) {
    const name = itemText(r?.name, 120);
    if (!name) continue;
    const quantity = Math.round(Number(r?.quantity));
    items.push({
      name,
      details: itemText(r?.details, 120),
      quantity: Number.isFinite(quantity) && quantity >= 1 ? Math.min(quantity, 999) : 1,
      price: parseAmount(r?.price),
      code: itemText(r?.code, 40),
    });
  }
  return items.slice(0, MAX_ITEMS);
}

export function summaryFrom(description: string): string {
  const at = description.indexOf(FACTS_MARK);
  return (at >= 0 ? description.slice(0, at) : description).trim();
}

// "1.234,56", "1,234.56", "87,45 €", "EUR 87.45" → number
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  if (typeof value !== 'string') return null;
  let s = value.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    // Both: the later one is the decimal mark
    s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (comma >= 0) {
    // "1,234" groups thousands; "87,45" has a decimal comma
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.234" and "1.234.567" group thousands in German notation
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
