// Paperwork as an MCP server: AI apps (Gemini, and others allowed in Settings) search the documents and read them,
// and answer with links that open the document in Paperwork. Reading only: nothing can be changed. Served at /mcp over
// Streamable HTTP without sessions (each request stands alone, which suits Cloud Run); every request carries an access
// token from oauth.ts. When Paperwork runs as two services this is the public edge's: it reads the index the app
// writes (a follower copy, docIndex.ts) and Drive, and never files anything.
//
// The tools answer in JSON. `search` and `fetch` have the shape ChatGPT's connectors look for (results with id,
// title and url; a document with id, title, text, url and metadata), and more besides.
import express, { Request } from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AuthInfo, CallToolResult, McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { fold, possibleCopies } from '../shared/filter.js';
import { companyPagePath, documentPath, topicPagePath } from '../shared/paths.js';
import { CONTRACT_KINDS, DOCUMENT_TYPES, DocumentInfo, DocumentType, PurchaseItem } from '../shared/types.js';
import { listAttachments } from './attachments.js';
import { config, today } from './config.js';
import { contracts } from './contracts.js';
import { getIndex } from './docIndex.js';
import { DriveError } from './drive.js';
import { UnsupportedFile, readFile } from './extract.js';
import { LimitError } from './gemini.js';
import { NotConnectedError, getDrive } from './google.js';
import { toInfo } from './indexing.js';
import { IndexNotReady, indexedDocuments } from './library.js';
import { SCOPE, mcpUrl, openCors, resourceMetadataUrl, verifyAccess } from './oauth.js';
import { search } from './search.js';
import { joinChunks, ownText } from './text.js';
import { Tree, VaultProblem, categoryInfos, loadTree } from './vault.js';

const DEFAULT_RESULTS = 10;
const MAX_RESULTS = 25;
// Text per fetch; the rest is read with next_offset
const TEXT_PER_FETCH = 25_000;
const MAX_LISTED = 200;
const DEADLINE_DAYS = 90;

const INSTRUCTIONS = `Paperwork holds the user's own documents: letters, bills, contracts, insurance policies, payslips, tax papers and more, filed in their Google Drive and read by AI. Each document has a company (who sent it), often a topic (the matter it belongs to, e.g. "Car insurance VW Golf" or "Income tax 2025", shared by documents from different companies), a category, the folder it is in (its category's year folder, or a folder the user made for a matter), a date, a summary, deadlines, and its full text.

- search finds documents by meaning and by exact words (names, numbers, reference numbers), optionally narrowed to a company, topic, category, type or dates. fetch reads one document in full.
- Files can be kept with a document, e.g. the Word draft of a signed contract. fetch lists them with links that open them in Google Drive. Paperwork doesn't read them, so search doesn't find their content.
- list_companies, list_topics and list_categories show what is there; list_deadlines shows what is due.
- Till receipts and shops' invoices list what was bought. list_purchases finds an item (a jacket, a laptop) with where and when it was bought, what it cost, the last day to return it and when its warranty ends, and the receipt's url.
- list_contracts gives the user's insurance policies, energy, phone and internet contracts, rent, loans, subscriptions and memberships: what each costs a month and a year, when it renews and the last day to cancel it.
- Every document, company and topic comes with a url that opens it in Paperwork. When you use a document in your answer, cite it as a link with its title, e.g. [Electricity bill March 2025](url), so the user can open it. Paperwork's links only work for the user, so never present them as public.
- "checked": false means the user hasn't checked what the AI read from the document yet; mention it when it matters.
- possible_duplicate_of names a document this one may be a copy of (the same letter scanned and emailed, say). The user hasn't decided yet; list_deadlines leaves its deadlines out meanwhile, so they aren't counted twice.
- Dates are YYYY-MM-DD. Today is given by list_deadlines.`;

class ToolProblem extends Error {}

const TYPE_KEYS = Object.keys(DOCUMENT_TYPES) as [DocumentType, ...DocumentType[]];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const link = (path: string) => `${config.appUrl}${path}`;
const docDate = (doc: DocumentInfo) => doc.date ?? doc.addedAt.slice(0, 10);

export { today };

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Leaves out what is empty, so answers stay short
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as Partial<T>;
}

const amountOf = (doc: DocumentInfo) => (doc.amount !== null ? `${doc.amount.toFixed(2)} ${doc.currency ?? ''}`.trim() : null);

// What a list of results says about each document; `copies` (possibleCopies) names the documents it may be a copy of
function brief(doc: DocumentInfo, copies?: Map<string, DocumentInfo>) {
  const original = copies?.get(doc.id);
  return compact({
    id: doc.id,
    title: doc.title,
    url: link(documentPath(doc.id)),
    date: doc.date,
    company: doc.correspondent,
    topic: doc.topic,
    category: doc.category,
    folder: doc.folderPath.join(' / '),
    type: doc.type ? DOCUMENT_TYPES[doc.type] : null,
    amount: amountOf(doc),
    bought: doc.items.map(i => itemLine(i, doc.currency)),
    open_deadlines: doc.deadlines.filter(d => !d.done).map(d => compact({ date: d.date, what: d.what, kind: d.kind })),
    summary: doc.summary,
    update: doc.gist,
    possible_duplicate_of: original ? { id: original.id, title: original.title, url: link(documentPath(original.id)) } : null,
    checked: !doc.needsReview && !original,
  });
}

// "2 × Fibertec Textile Guard Eco (one size) 28.82 EUR"
const itemLine = (item: PurchaseItem, currency: string | null) =>
  `${item.quantity > 1 ? `${item.quantity} × ` : ''}${item.name}${item.details ? ` (${item.details})` : ''}${item.price !== null ? ` ${item.price.toFixed(2)}${currency ? ` ${currency}` : ''}` : ''}`;

// The loose match an AI app's filter gets: any case, accents or not, part of the name
const loosely = (wanted: string | undefined) => {
  const want = fold(wanted?.trim() ?? '');
  return (value: string | null) => !want || (!!value && fold(value).includes(want));
};

async function vault(): Promise<{ tree: Tree; documents: DocumentInfo[] }> {
  const tree = await loadTree(getDrive());
  return { tree, documents: (await indexedDocuments(tree)).map(toInfo) };
}

// ---------- Tools ----------

interface SearchArgs {
  query: string;
  company?: string;
  topic?: string;
  category?: string;
  type?: DocumentType;
  from?: string;
  to?: string;
  limit?: number;
}

export async function searchTool(args: SearchArgs) {
  const { tree, documents } = await vault();
  const company = loosely(args.company);
  const topic = loosely(args.topic);
  const category = loosely(args.category);
  const pool = documents.filter(
    d =>
      company(d.correspondent) &&
      topic(d.topic) &&
      category(d.category) &&
      (!args.type || d.type === args.type) &&
      (!args.from || docDate(d) >= args.from) &&
      (!args.to || docDate(d) <= args.to)
  );
  const limit = args.limit ?? DEFAULT_RESULTS;
  const query = args.query.trim();
  const copies = possibleCopies(documents);
  const notes: string[] = [];
  for (const [name, wanted, values] of [
    ['company', args.company, documents.map(d => d.correspondent)],
    ['topic', args.topic, documents.map(d => d.topic)],
    ['category', args.category, documents.map(d => d.category)],
  ] as const) {
    if (wanted?.trim() && !values.some(loosely(wanted))) notes.push(`No ${name} is called anything like "${wanted}"; list_${name === 'company' ? 'companies' : name === 'category' ? 'categories' : 'topics'} shows the names.`);
  }

  if (!query) {
    const listed = [...pool].sort((a, b) => docDate(b).localeCompare(docDate(a)));
    return compact({ total: listed.length, results: listed.slice(0, limit).map(d => brief(d, copies)), note: notes.join(' ') || null });
  }

  const { hits, semantic } = await search(getDrive(), tree, query);
  const allowed = new Map(pool.map(d => [d.id, d]));
  const ranked = hits.filter(h => allowed.has(h.id));
  if (!semantic) notes.push('Searching by meaning is unavailable right now (the AI budget for today may be used up), so only exact words were matched.');
  if (ranked.length && ranked.every(h => h.match === 'meaning')) notes.push('No document contains these words; the results are only related by meaning.');
  return compact({
    total: ranked.length,
    results: ranked.slice(0, limit).map(h => ({
      ...brief(allowed.get(h.id)!, copies),
      ...compact({ excerpt: h.snippet, related_only: h.match === 'meaning' ? true : null }),
    })),
    note: notes.join(' ') || null,
  });
}

// An ID as search gives it, or a Paperwork link to the document
export function documentId(value: string): string | null {
  const text = value.trim();
  let id = text;
  if (/^https?:\/\//.test(text) || text.startsWith('/')) {
    try {
      id = new URL(text, config.appUrl).searchParams.get('doc') ?? '';
    } catch {
      return null;
    }
  }
  return /^[\w-]{1,200}$/.test(id) ? id : null;
}

// The files kept with a document (a Word draft, a spreadsheet), which Paperwork doesn't read: what they are and where
// to open them. The document is read without them when Drive can't list them.
async function keptFiles(id: string) {
  try {
    const drive = getDrive();
    const kept = await listAttachments(drive, await loadTree(drive), id);
    return kept.map(a => ({ name: a.name, label: a.label, google_drive_url: a.webViewLink }));
  } catch (err) {
    console.warn(`Listing the files kept with ${id} for an AI app failed:`, (err as Error)?.message);
    return [];
  }
}

export async function fetchTool(args: { id: string; offset?: number }) {
  const id = documentId(args.id);
  const doc = id && (await getIndex().get(id));
  if (!doc) throw new ToolProblem(`Paperwork has no document "${args.id}". Use search to find documents and their ids.`);
  const info = toInfo(doc);
  // In memory: whether it may be a copy of a document still in Paperwork
  const copies = possibleCopies((await getIndex().all()).map(toInfo));

  const [chunks, kept] = await Promise.all([getIndex().chunks(doc.id), keptFiles(doc.id)]);
  let text = joinChunks(
    chunks
      .filter(c => c.n > 0)
      .sort((a, b) => a.n - b.n)
      .map(c => c.text)
  );
  let note: string | null = null;
  if (!text && doc.textSource === null) {
    // Not read for the index yet: a PDF's own text (or a text file) is read now; a scan waits for the index
    try {
      const own = await ownText(await readFile(getDrive(), { id: doc.id, name: doc.name, mimeType: doc.mimeType, size: doc.size ? String(doc.size) : undefined }));
      text = own?.text ?? '';
    } catch (err) {
      if (!(err instanceof UnsupportedFile)) console.warn(`Reading ${doc.name} for an AI app failed:`, (err as Error)?.message);
    }
    if (!text) note = 'Paperwork hasn’t read this document’s text yet (it will soon). The summary describes it; the link opens it.';
  } else if (!text) {
    note = 'Paperwork found no text in this document (a photo, or a file it can’t read). The summary describes it; the link opens it.';
  }

  const from = Math.min(args.offset ?? 0, text.length);
  const part = text.slice(from, from + TEXT_PER_FETCH);
  const next = from + part.length < text.length ? from + part.length : null;
  return {
    id: info.id,
    title: info.title,
    url: link(documentPath(info.id)),
    text: part,
    metadata: compact({
      ...brief(info, copies),
      id: undefined,
      title: undefined,
      url: undefined,
      open_deadlines: undefined,
      deadlines: info.deadlines,
      tags: info.tags,
      references: info.references,
      action: info.action,
      added: info.addedAt.slice(0, 10),
      waiting_in_inbox: info.inInbox || null,
      file_name: info.name,
      google_drive_url: info.webViewLink,
      kept_files: kept,
      text_chars: text.length,
      text_offset: from || null,
      next_offset: next,
      note: [note, copies.has(info.id) ? 'It may be a copy of another document (possible_duplicate_of); its deadlines are left out of list_deadlines until the user decides.' : null].filter(Boolean).join(' ') || null,
    }),
  };
}

export async function companiesTool(args: { name?: string }) {
  const { documents } = await vault();
  const wanted = loosely(args.name);
  const companies = new Map<string, DocumentInfo[]>();
  for (const doc of documents) {
    if (doc.correspondent && wanted(doc.correspondent)) companies.set(doc.correspondent, [...(companies.get(doc.correspondent) ?? []), doc]);
  }
  const listed = [...companies.entries()]
    .map(([name, docs]) => {
      const dates = docs.map(docDate).sort();
      return {
        name,
        url: link(companyPagePath(name)),
        documents: docs.length,
        first: dates[0],
        last: dates[dates.length - 1],
        topics: [...new Set(docs.map(d => d.topic).filter((t): t is string => !!t))].sort(),
      };
    })
    .sort((a, b) => b.last.localeCompare(a.last));
  return compact({ total: listed.length, companies: listed.slice(0, MAX_LISTED).map(compact) });
}

export async function topicsTool(args: { name?: string; company?: string }) {
  const { documents } = await vault();
  const wanted = loosely(args.name);
  const company = loosely(args.company);
  const topics = new Map<string, DocumentInfo[]>();
  for (const doc of documents) {
    if (doc.topic && wanted(doc.topic)) topics.set(doc.topic, [...(topics.get(doc.topic) ?? []), doc]);
  }
  const listed = [...topics.entries()]
    .filter(([, docs]) => docs.some(d => company(d.correspondent)))
    .map(([name, docs]) => {
      const sorted = [...docs].sort((a, b) => docDate(a).localeCompare(docDate(b)));
      const latest = [...sorted].reverse().find(d => d.gist);
      return compact({
        name,
        url: link(topicPagePath(name)),
        documents: docs.length,
        first: docDate(sorted[0]),
        last: docDate(sorted[sorted.length - 1]),
        companies: [...new Set(docs.map(d => d.correspondent).filter((c): c is string => !!c))].sort(),
        latest_update: latest ? `${docDate(latest)}: ${latest.gist}` : null,
      });
    })
    .sort((a, b) => b.last!.localeCompare(a.last!));
  return compact({ total: listed.length, topics: listed.slice(0, MAX_LISTED) });
}

export async function categoriesTool() {
  const { tree, documents } = await vault();
  return { categories: categoryInfos(tree, documents).map(c => compact({ name: c.name, description: c.description, documents: c.count })) };
}

export async function deadlinesTool(args: { from?: string; to?: string; overdue?: boolean; include_done?: boolean }) {
  const { documents } = await vault();
  const now = today();
  const from = args.from ?? now;
  const to = args.to ?? addDays(from, DEADLINE_DAYS);
  const all = documents
    .flatMap(doc => doc.deadlines.map(deadline => ({ doc, deadline })))
    // A missed return or warranty date has lapsed rather than being overdue
    .filter(({ deadline: d }) => (args.include_done || !d.done) && d.date <= to && (d.date >= from || (args.overdue !== false && !d.done && !d.kind)));
  // A possible copy's deadlines are its original's: not counted twice while the user hasn't decided
  const copies = possibleCopies(documents);
  const left = all.filter(({ doc }) => copies.has(doc.id)).length;
  const listed = all
    .filter(({ doc }) => !copies.has(doc.id))
    .sort((a, b) => a.deadline.date.localeCompare(b.deadline.date))
    .map(({ doc, deadline: d }) =>
      compact({
        date: d.date,
        what: d.what,
        kind: d.kind,
        done: d.done,
        overdue: !d.done && !d.kind && d.date < now ? true : null,
        document: compact({ id: doc.id, title: doc.title, url: link(documentPath(doc.id)), company: doc.correspondent, topic: doc.topic }),
      })
    );
  return compact({
    today: now,
    from,
    to,
    total: listed.length,
    deadlines: listed.slice(0, MAX_LISTED),
    note: left ? `${left} ${left === 1 ? 'deadline' : 'deadlines'} of documents that may be copies of others ${left === 1 ? 'is' : 'are'} left out until the user decides; fetch shows them.` : null,
  });
}

export async function purchasesTool(args: { query?: string; from?: string; to?: string; limit?: number }) {
  const { documents } = await vault();
  const terms = fold(args.query ?? '').split(/\s+/).filter(Boolean);
  const dateOf = (doc: DocumentInfo, kind: 'return' | 'warranty') => doc.deadlines.find(d => d.kind === kind)?.date ?? null;
  // A possible copy of a receipt lists the same things again
  const copies = possibleCopies(documents);
  const rows = documents
    .filter(doc => doc.items.length && !copies.has(doc.id) && (!args.from || docDate(doc) >= args.from) && (!args.to || docDate(doc) <= args.to))
    .sort((a, b) => docDate(b).localeCompare(docDate(a)))
    .flatMap(doc =>
      doc.items
        .filter(item => {
          const text = fold([item.name, item.details, item.code, doc.correspondent].filter(Boolean).join(' '));
          return terms.every(t => text.includes(t));
        })
        .map(item =>
          compact({
            item: item.name,
            details: item.details,
            quantity: item.quantity > 1 ? item.quantity : null,
            price: item.price !== null ? `${item.price.toFixed(2)}${doc.currency ? ` ${doc.currency}` : ''}` : null,
            code: item.code,
            store: doc.correspondent,
            date: docDate(doc),
            return_by: dateOf(doc, 'return'),
            warranty_until: dateOf(doc, 'warranty'),
            checked: !doc.needsReview,
            receipt: compact({ id: doc.id, title: doc.title, url: link(documentPath(doc.id)) }),
          })
        )
    );
  const limit = args.limit ?? 50;
  return compact({
    today: today(),
    total: rows.length,
    purchases: rows.slice(0, limit),
    note: rows.length ? null : terms.length ? 'Nothing bought matches; search looks through the documents’ text too.' : 'No receipts with items yet.',
  });
}

// As read when the user last opened Contracts in Paperwork (reading them takes the AI a while)
export async function contractsTool(args: { include_ended?: boolean }) {
  const [{ contracts: list, pending }, docs] = await Promise.all([contracts(), getIndex().all()]);
  const byId = new Map(docs.map(d => [d.id, d]));
  const money = (amount: number | null, currency: string | null) => (amount !== null ? `${amount.toFixed(2)}${currency ? ` ${currency}` : ''}` : null);
  const rows = list
    .filter(c => args.include_ended || c.status !== 'ended')
    .map(c =>
      compact({
        name: c.name,
        kind: CONTRACT_KINDS[c.kind],
        provider: c.provider,
        reference: c.reference,
        price: c.amount !== null ? `${money(c.amount, c.currency)}${c.interval ? ` per ${c.interval}` : ''}` : null,
        per_year: money(c.yearly, c.currency),
        since: c.since,
        renews: c.renews,
        notice_period: c.notice,
        cancel_by: c.cancelBy,
        status: c.status,
        ends_on: c.endsOn,
        latest_change: c.latest,
        topic: { name: c.topic, url: link(topicPagePath(c.topic)) },
        documents: c.documentIds.flatMap(id => {
          const doc = byId.get(id);
          return doc ? [{ title: doc.title, date: docDate(doc), url: link(documentPath(id)) }] : [];
        }),
      })
    );
  return compact({
    today: today(),
    total: rows.length,
    contracts: rows,
    note: pending ? `${pending} topics haven’t been looked at yet; Paperwork reads them when the user opens Contracts.` : null,
  });
}

// ---------- The server ----------

const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });

async function answer(tool: string, run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    // On the edge, the copy of the index takes in what the app wrote meanwhile
    await getIndex().ensureFresh();
    return result(await run());
  } catch (err) {
    const problem = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
    if (err instanceof ToolProblem || err instanceof NotConnectedError || err instanceof VaultProblem || err instanceof LimitError || err instanceof IndexNotReady) return problem(err.message);
    if (err instanceof DriveError) return problem(`Google Drive didn’t answer as expected: ${err.message}`);
    console.error(`The MCP tool ${tool} failed:`, err);
    return problem('Paperwork couldn’t do that just now. Please try again.');
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const day = (what: string) => z.string().regex(DATE, 'A date as YYYY-MM-DD').optional().describe(what);

export function paperworkServer(): McpServer {
  const server = new McpServer({ name: 'paperwork', title: 'Paperwork', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'search',
    {
      title: 'Search documents',
      description:
        'Finds documents by meaning and by exact words in their text, title, company, topic and summary, best first. Each result has an id (for fetch), a url that opens it in Paperwork (cite it), and what Paperwork knows: date, company, topic, category, folder, amount, open deadlines, summary, and an excerpt of the text that matched. With an empty query, lists the documents the filters select, newest first.',
      inputSchema: z.object({
        query: z
          .string()
          .max(500)
          .describe('What to look for, in any language: words, names, numbers or a question ("car insurance premium", "DE89 3704", "when does the lease end"). Empty to list documents by the filters alone.'),
        company: z.string().max(200).optional().describe('Only documents from this company, office or person (as list_companies names them; part of the name is enough).'),
        topic: z.string().max(200).optional().describe('Only documents about this matter (as list_topics names it; part of the name is enough).'),
        category: z.string().max(200).optional().describe('Only documents in this folder (as list_categories names it).'),
        type: z.enum(TYPE_KEYS).optional().describe(`Only documents of this type: ${TYPE_KEYS.map(k => `${k} (${DOCUMENT_TYPES[k]})`).join(', ')}.`),
        from: day('Only documents dated on or after this day.'),
        to: day('Only documents dated on or before this day.'),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`How many results, ${DEFAULT_RESULTS} unless said otherwise.`),
      }),
      annotations: READ_ONLY,
    },
    args => answer('search', () => searchTool(args))
  );

  server.registerTool(
    'fetch',
    {
      title: 'Read a document',
      description:
        'Reads one document: its full text (as read from the PDF, or transcribed from the scan) and everything Paperwork knows about it, with a url that opens it in Paperwork. Also the folder it is in, and the files kept with it (e.g. its Word draft: name, label and a link to open it in Google Drive; Paperwork doesn’t read them). Long texts come in parts: call again with offset set to next_offset for the rest.',
      inputSchema: z.object({
        id: z.string().max(2000).describe('The document’s id, as search or another tool gave it (its Paperwork url works too).'),
        offset: z.number().int().min(0).optional().describe('Where in the text to go on reading: next_offset from the previous part.'),
      }),
      annotations: READ_ONLY,
    },
    args => answer('fetch', () => fetchTool(args))
  );

  server.registerTool(
    'list_companies',
    {
      title: 'List companies',
      description:
        'The companies, offices and people documents came from, most recent first: how many documents, from when to when, the topics they wrote about, and a url to the company’s page in Paperwork.',
      inputSchema: z.object({ name: z.string().max(200).optional().describe('Only companies whose name contains this.') }),
      annotations: READ_ONLY,
    },
    args => answer('list_companies', () => companiesTool(args))
  );

  server.registerTool(
    'list_topics',
    {
      title: 'List topics',
      description:
        'The matters documents belong to (a contract, policy, account, case or tax year, e.g. "Car insurance VW Golf", "Income tax 2025"), most recent first: the companies involved, how many documents, from when to when, the latest update, and a url to the topic’s timeline in Paperwork.',
      inputSchema: z.object({
        name: z.string().max(200).optional().describe('Only topics whose name contains this.'),
        company: z.string().max(200).optional().describe('Only topics with documents from this company.'),
      }),
      annotations: READ_ONLY,
    },
    args => answer('list_topics', () => topicsTool(args))
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description: 'The folders documents are filed in, what belongs in each, and how many documents each has.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () => answer('list_categories', () => categoriesTool())
  );

  server.registerTool(
    'list_deadlines',
    {
      title: 'List deadlines',
      description:
        'Dates documents ask something by (pay, reply, cancel, renew, …), soonest first, each with its document and a url to it. By default the open deadlines of the next 90 days and those already overdue. Also says what day it is today.',
      inputSchema: z.object({
        from: day('From this day (today unless said otherwise).'),
        to: day(`Up to this day (${DEADLINE_DAYS} days after from unless said otherwise).`),
        overdue: z.boolean().optional().describe('Also open deadlines before from (true unless said otherwise).'),
        include_done: z.boolean().optional().describe('Also deadlines the user marked as done (false unless said otherwise).'),
      }),
      annotations: READ_ONLY,
    },
    args => answer('list_deadlines', () => deadlinesTool(args))
  );

  server.registerTool(
    'list_purchases',
    {
      title: 'List purchases',
      description:
        'Things bought, from till receipts and shops’ invoices, newest first: each item with the store, the date, what it cost, its article number, the last day to return it and when its warranty ends (where known), and a url to its receipt in Paperwork. For questions like when or where something was bought, what it cost, or whether it can still be returned.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('Only items whose name, details, article number or store contain all these words ("arcteryx jacket", "norrona").'),
        from: day('Only purchases on or after this day.'),
        to: day('Only purchases on or before this day.'),
        limit: z.number().int().min(1).max(MAX_LISTED).optional().describe('How many items, 50 unless said otherwise.'),
      }),
      annotations: READ_ONLY,
    },
    args => answer('list_purchases', () => purchasesTool(args))
  );

  server.registerTool(
    'list_contracts',
    {
      title: 'List contracts',
      description:
        'The user’s ongoing contracts: insurance policies, energy, phone and internet contracts, rent, loans, subscriptions and memberships. Each with its provider and number, what it costs per month or year, when it renews, the notice period and the last day to cancel, whether it was cancelled, its latest change, and urls to its topic and documents in Paperwork. For questions like what they pay for insurance, which contracts they could switch, or by when to cancel.',
      inputSchema: z.object({
        include_ended: z.boolean().optional().describe('Also contracts that have ended (false unless said otherwise).'),
      }),
      annotations: READ_ONLY,
    },
    args => answer('list_contracts', () => contractsTool(args))
  );

  return server;
}

// ---------- HTTP ----------

const handler = createMcpHandler(() => paperworkServer(), {
  legacy: 'stateless',
  onerror: err => console.warn('An MCP request failed:', err.message),
});
const serve = toNodeHandler(handler, { onerror: err => console.error('Serving an MCP request failed:', err) });

export const mcpRouter = express.Router();
mcpRouter.use(openCors);

// Only with an access token from oauth.ts. Without one, the answer says where to get one (RFC 9728), which is how
// an AI app finds out to ask the owner.
mcpRouter.use(async (req, res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const access = token ? await verifyAccess(token) : null;
  if (!access) {
    const invalid = token ? ', error="invalid_token", error_description="The access token is invalid or has expired."' : '';
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl()}", scope="${SCOPE}"${invalid}`);
    return res.status(401).json({ error: 'invalid_token', error_description: token ? 'The access token is invalid or has expired.' : 'Connect Paperwork in your AI app first.' });
  }
  const auth: AuthInfo = { token, clientId: access.client, scopes: [SCOPE], expiresAt: access.expiresAt, resource: new URL(mcpUrl()), extra: { email: access.email } };
  (req as Request & { auth?: AuthInfo }).auth = auth;
  next();
});

mcpRouter.use(express.json({ limit: '1mb' }));
mcpRouter.all('/', (req, res) => serve(req, res, req.body));
