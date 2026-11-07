// Searching, filtering and sorting the library. Runs in the browser over all documents at once, which stays
// instant for thousands of documents; the server's search (by meaning, and Drive's full-text search) adds
// matches from inside the files.
import { DOCUMENT_TYPES, Deadline, DocumentInfo, SortKey, ViewFilters } from './types';

// Letters that aren't a plain letter with a mark, written the way people type them without the key: "norrona"
// finds Norrøna, "strasse" Straße
const PLAIN: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

export const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øæœßłđðþı]/g, c => PLAIN[c]);

export function haystack(doc: DocumentInfo): string {
  return fold(
    [
      doc.title,
      doc.name,
      doc.correspondent,
      doc.summary,
      doc.tags.join(' '),
      doc.references,
      doc.action,
      doc.topic,
      doc.gist,
      (doc.items ?? []).map(i => [i.name, i.details, i.code].filter(Boolean).join(' ')).join(' '),
      doc.category,
      doc.type ? DOCUMENT_TYPES[doc.type] : '',
      doc.date,
      doc.amount !== null ? doc.amount.toFixed(2) : '',
    ]
      .filter(Boolean)
      .join(' ')
  );
}

export const docYear = (doc: DocumentInfo) => (doc.date ?? doc.addedAt).slice(0, 4);

// Documents matching the filters. `found` are the documents the server's search found for the query, best
// first: they lead the results, followed by the other matches in the chosen order.
export function applyFilters(documents: DocumentInfo[], filters: ViewFilters, found?: string[]): DocumentInfo[] {
  const terms = fold(filters.query ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const rank = new Map(terms.length ? (found ?? []).map((id, i) => [id, i] as const) : []);
  const result = documents.filter(doc => {
    if (filters.categoryId && doc.categoryId !== filters.categoryId) return false;
    if (filters.folderId && doc.folderId !== filters.folderId) return false;
    if (filters.type && doc.type !== filters.type) return false;
    if (filters.year && docYear(doc) !== filters.year) return false;
    if (filters.correspondent && doc.correspondent !== filters.correspondent) return false;
    if (filters.topic && doc.topic !== filters.topic) return false;
    if (filters.tags?.length && !filters.tags.every(t => doc.tags.includes(t))) return false;
    if (filters.starred && !doc.starred) return false;
    // To check: not checked yet, or a possible copy of another document to decide about
    if (filters.review && !doc.needsReview && !doc.possibleDuplicateOf) return false;
    if (terms.length && !rank.has(doc.id)) {
      const text = haystack(doc);
      if (!terms.every(t => text.includes(t))) return false;
    }
    return true;
  });
  const sorted = sortDocuments(result, filters.sort ?? 'date', filters.order ?? defaultOrder(filters.sort ?? 'date'));
  if (!rank.size) return sorted;
  const hits = sorted.filter(d => rank.has(d.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...hits, ...sorted.filter(d => !rank.has(d.id))];
}

export const defaultOrder = (sort: SortKey): 'asc' | 'desc' => (sort === 'title' || sort === 'due' ? 'asc' : 'desc');

export function sortDocuments(documents: DocumentInfo[], sort: SortKey, order: 'asc' | 'desc'): DocumentInfo[] {
  const key = (d: DocumentInfo): string | number | null => {
    switch (sort) {
      case 'title':
        return fold(d.title);
      case 'amount':
        return d.amount;
      case 'due':
        return d.dueDate;
      case 'added':
        return d.addedAt;
      default:
        return d.date ?? d.addedAt.slice(0, 10);
    }
  };
  const dir = order === 'asc' ? 1 : -1;
  return [...documents].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    // Documents without the value go last either way
    if (ka === null && kb === null) return b.addedAt.localeCompare(a.addedAt);
    if (ka === null) return 1;
    if (kb === null) return -1;
    if (ka < kb) return -dir;
    if (ka > kb) return dir;
    return b.addedAt.localeCompare(a.addedAt);
  });
}

export interface Facet {
  value: string;
  count: number;
}

function count(values: (string | null)[]): Facet[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].map(([value, n]) => ({ value, count: n }));
}

export function facets(documents: DocumentInfo[]) {
  return {
    years: count(documents.map(docYear)).sort((a, b) => b.value.localeCompare(a.value)),
    types: count(documents.map(d => d.type)).sort((a, b) => b.count - a.count),
    correspondents: count(documents.map(d => d.correspondent)).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    tags: count(documents.flatMap(d => d.tags)).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  };
}

export function activeFilters(filters: ViewFilters): number {
  return [filters.categoryId, filters.folderId, filters.type, filters.year, filters.correspondent, filters.topic, filters.tags?.length, filters.starred, filters.review].filter(Boolean).length;
}

export interface DeadlineItem {
  doc: DocumentInfo;
  deadline: Deadline;
}

// Documents that may be copies of another document in the same list: copy id → that one. A mark naming a document
// that isn't in the list, or that is marked itself, doesn't count (that one left Paperwork, or the marks form a chain).
export function possibleCopies(documents: DocumentInfo[]): Map<string, DocumentInfo> {
  const byId = new Map(documents.map(d => [d.id, d]));
  const marked = (d: DocumentInfo) => !!d.possibleDuplicateOf && d.possibleDuplicateOf !== d.id && byId.has(d.possibleDuplicateOf);
  const copies = new Map<string, DocumentInfo>();
  for (const d of documents) {
    if (!marked(d)) continue;
    const original = byId.get(d.possibleDuplicateOf!)!;
    if (!marked(original)) copies.set(d.id, original);
  }
  return copies;
}

// Every deadline of every document, soonest first; those of a possible copy aren't counted until the owner decides
export function deadlineItems(documents: DocumentInfo[]): DeadlineItem[] {
  const copies = possibleCopies(documents);
  return documents
    .filter(doc => !copies.has(doc.id))
    .flatMap(doc => doc.deadlines.map(deadline => ({ doc, deadline })))
    .sort((a, b) => a.deadline.date.localeCompare(b.deadline.date) || a.doc.title.localeCompare(b.doc.title));
}

// The open deadlines left out because their document may be a copy, to say so where deadlines are listed
export function heldBack(documents: DocumentInfo[], today = localToday()): DeadlineItem[] {
  const copies = possibleCopies(documents);
  return documents
    .filter(doc => copies.has(doc.id))
    .flatMap(doc => doc.deadlines.filter(d => !d.done && !lapsed(d, today)).map(deadline => ({ doc, deadline })))
    .sort((a, b) => a.deadline.date.localeCompare(b.deadline.date) || a.doc.title.localeCompare(b.doc.title));
}

export const deadlineKey = ({ doc, deadline }: DeadlineItem) => `${doc.id}|${deadline.date}|${deadline.what}`;

// A purchase's last day to return it, or the end of its warranty, once past without being ticked off: a chance
// that ended rather than something owed, so it is never overdue and drops out of the open lists
export const lapsed = (deadline: Deadline, today = localToday()) => !!deadline.kind && !deadline.done && deadline.date < today;

// Deadlines not done yet from two weeks ago to two months ahead, soonest first: bills to pay, contracts to
// cancel, letters to answer (not the return dates of purchases that passed)
export function upcoming(documents: DocumentInfo[], today = localToday()): DeadlineItem[] {
  const from = shiftDate(today, -14);
  const to = shiftDate(today, 60);
  return deadlineItems(documents).filter(({ deadline: d }) => !d.done && !lapsed(d, today) && d.date >= from && d.date <= to);
}

// Today in the reader's time zone, as YYYY-MM-DD (a deadline is overdue from the reader's midnight, not UTC's)
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// The same day of the month, `months` later (or earlier); the 31st becomes the month's last day when it has fewer
export function shiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
